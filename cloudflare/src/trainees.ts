import { z } from "zod";
import type { Env, FinalEvaluationRow, ObservationRow, Principal, SelfSectionRow, SignatureRow, TraineeRow, UserRow } from "./types";
import {
  ApiError,
  MAX_SIGNATURE_BYTES,
  json,
  noContent,
  readJson,
  routeMatch,
  safeFilename,
  validationError,
} from "./http";
import {
  audit,
  assertOpenVersion,
  finalEvaluationPayloadHash,
  getCurrentSnapshot,
  getTrainee,
  mapTrainee,
  observationPayloadHash,
  publicSnapshot,
  selfSectionPayloadHash,
  stableStringify,
} from "./data";
import {
  bootstrapSchema,
  closeSchema,
  finalEvaluationSchema,
  loginSchema,
  newVersionSchema,
  observationCreateSchema,
  observationUpdateSchema,
  selfSectionSchema,
  shareExchangeSchema,
  shareLinkSchema,
  signatureSchema,
  traineeCreateSchema,
  traineeUpdateSchema,
  userCreateSchema,
  userUpdateSchema,
} from "./schemas";
import {
  clearTraineeCookie,
  clearUserCookie,
  createTraineeSessionToken,
  limiterKey,
  pinCredentials,
  principalFromUserRow,
  publicUser,
  randomId,
  randomToken,
  requireRole,
  sha256Bytes,
  sha256Text,
  traineeCookie,
  traineeSessionFromRequest,
  userSessionFromRequest,
} from "./security";
import { authenticateWithPin } from "./legacy";
import { generateFinalPdf } from "./pdf";
import { ensureSchema } from "./schema";

const FRONTEND_ORIGIN = "https://responsable.esapin.com";

type RecordAccess =
  | { kind: "user"; principal: Principal }
  | { kind: "trainee"; traineeId: string; linkId: string };

export async function handleV2(request: Request, env: Env, origin: string): Promise<Response> {
  await ensureSchema(env);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/v2/health") return health(request, env, origin);
  if (path === "/v2/setup/status") return setupStatus(request, env, origin);
  if (path === "/v2/setup/bootstrap") return bootstrap(request, env, origin);
  if (path === "/v2/auth/login") return login(request, env, origin);
  if (path === "/v2/auth/logout") return logout(request, origin);
  if (path === "/v2/auth/session") return session(request, env, origin);
  if (path === "/v2/share/exchange") return exchangeShareLink(request, env, origin);
  if (path === "/v2/share/logout") return shareLogout(request, origin);
  if (path === "/v2/directory") return listDirectory(request, env, origin);
  if (path === "/v2/trainees") {
    if (request.method === "GET") return listTrainees(request, env, origin);
    if (request.method === "POST") return createTrainee(request, env, origin);
    throw new ApiError("METHODE_REFUSEE", "Méthode non autorisée.", 405);
  }
  if (path === "/v2/admin/users") {
    if (request.method === "GET") return listUsers(request, env, origin);
    if (request.method === "POST") return createUser(request, env, origin);
    throw new ApiError("METHODE_REFUSEE", "Méthode non autorisée.", 405);
  }

  let match = routeMatch(path, /^\/v2\/admin\/users\/([^/]+)$/);
  if (match) return updateUser(request, env, origin, decodeURIComponent(match[1] || ""));

  match = routeMatch(path, /^\/v2\/trainees\/([^/]+)$/);
  if (match) {
    const id = decodeURIComponent(match[1] || "");
    if (request.method === "GET") return getRecord(request, env, origin, id);
    if (request.method === "PATCH") return updateTrainee(request, env, origin, id);
    throw new ApiError("METHODE_REFUSEE", "Méthode non autorisée.", 405);
  }

  match = routeMatch(path, /^\/v2\/trainees\/([^/]+)\/share-link$/);
  if (match) return createShareLink(request, env, origin, decodeURIComponent(match[1] || ""));

  match = routeMatch(path, /^\/v2\/trainees\/([^/]+)\/share-links$/);
  if (match) return revokeShareLinks(request, env, origin, decodeURIComponent(match[1] || ""));

  match = routeMatch(path, /^\/v2\/trainees\/([^/]+)\/observations$/);
  if (match) return createObservation(request, env, origin, decodeURIComponent(match[1] || ""));

  match = routeMatch(path, /^\/v2\/trainees\/([^/]+)\/observations\/([^/]+)$/);
  if (match) return updateObservation(request, env, origin, decodeURIComponent(match[1] || ""), decodeURIComponent(match[2] || ""));

  match = routeMatch(path, /^\/v2\/trainees\/([^/]+)\/observations\/([^/]+)\/signature$/);
  if (match) return signObservation(request, env, origin, decodeURIComponent(match[1] || ""), decodeURIComponent(match[2] || ""));

  match = routeMatch(path, /^\/v2\/trainees\/([^/]+)\/self-section$/);
  if (match) return saveSelfSection(request, env, origin, decodeURIComponent(match[1] || ""));

  match = routeMatch(path, /^\/v2\/trainees\/([^/]+)\/self-section\/signature$/);
  if (match) return signSelfSection(request, env, origin, decodeURIComponent(match[1] || ""));

  match = routeMatch(path, /^\/v2\/trainees\/([^/]+)\/final-evaluation$/);
  if (match) return saveFinalEvaluation(request, env, origin, decodeURIComponent(match[1] || ""));

  match = routeMatch(path, /^\/v2\/trainees\/([^/]+)\/final-evaluation\/signature$/);
  if (match) return signFinalEvaluation(request, env, origin, decodeURIComponent(match[1] || ""));

  match = routeMatch(path, /^\/v2\/trainees\/([^/]+)\/close$/);
  if (match) return closeRecord(request, env, origin, decodeURIComponent(match[1] || ""));

  match = routeMatch(path, /^\/v2\/trainees\/([^/]+)\/new-version$/);
  if (match) return createNewVersion(request, env, origin, decodeURIComponent(match[1] || ""));

  match = routeMatch(path, /^\/v2\/trainees\/([^/]+)\/documents\/(\d+)$/);
  if (match) return downloadDocument(request, env, origin, decodeURIComponent(match[1] || ""), Number(match[2]));

  throw new ApiError("ROUTE_INTROUVABLE", "Cette adresse API n’existe pas.", 404);
}

async function health(request: Request, env: Env, origin: string): Promise<Response> {
  requireGet(request);
  let database = "ready";
  let schemaVersion: number | null = null;
  try {
    await env.DB.prepare("SELECT 1").first();
    const migration = await env.DB.prepare("SELECT MAX(version) AS version FROM app_schema_migrations").first<{ version: number | null }>();
    schemaVersion = migration?.version || null;
  } catch {
    database = "needs_migration";
  }
  return json({ ok: true, service: "suivi-stagiaires", database, schemaVersion, time: new Date().toISOString() }, database === "ready" ? 200 : 503, origin);
}

async function setupStatus(request: Request, env: Env, origin: string): Promise<Response> {
  requireGet(request);
  try {
    const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE active = 1").first<{ count: number }>();
    return json({ ok: true, schemaReady: true, setupRequired: Number(row?.count || 0) === 0, legacyAvailable: Boolean(env.APPS_SCRIPT_URL && env.APPS_SCRIPT_KEY) }, 200, origin);
  } catch {
    return json({ ok: true, schemaReady: false, setupRequired: true, legacyAvailable: Boolean(env.APPS_SCRIPT_URL && env.APPS_SCRIPT_KEY) }, 200, origin);
  }
}

async function bootstrap(request: Request, env: Env, origin: string): Promise<Response> {
  requirePost(request);
  if (!env.BOOTSTRAP_TOKEN || env.BOOTSTRAP_TOKEN.length < 32) throw new ApiError("INITIALISATION_DESACTIVEE", "L’initialisation de secours n’est pas activée.", 403);
  const input = parse(bootstrapSchema, await readJson(request));
  const [given, expected] = await Promise.all([sha256Text(input.token), sha256Text(env.BOOTSTRAP_TOKEN)]);
  if (given !== expected) throw new ApiError("INITIALISATION_REFUSEE", "Jeton d’initialisation incorrect.", 403);
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>();
  if (Number(count?.count || 0) !== 0) throw new ApiError("INITIALISATION_TERMINEE", "Un administrateur existe déjà.", 409);
  const user = await insertUser(env, input);
  return json({ ok: true, user: publicUser(principalFromUserRow(user)) }, 201, origin);
}

async function login(request: Request, env: Env, origin: string): Promise<Response> {
  requirePost(request);
  const [ipLimit, globalLimit] = await Promise.all([
    env.LOGIN_IP_LIMITER.limit({ key: await limiterKey(request) }),
    env.LOGIN_GLOBAL_LIMITER.limit({ key: "all-logins" }),
  ]);
  if (!ipLimit.success || !globalLimit.success) throw new ApiError("TROP_DE_TENTATIVES", "Trop de tentatives. Attendez une minute avant de réessayer.", 429);
  const input = parse(loginSchema, await readJson(request, 2_000));
  const authenticated = await authenticateWithPin(env, input.code);
  return json({ ok: true, user: publicUser(authenticated.principal) }, 200, origin, { "Set-Cookie": authenticated.cookie });
}

async function logout(request: Request, origin: string): Promise<Response> {
  requirePost(request);
  return json({ ok: true }, 200, origin, { "Set-Cookie": clearUserCookie() });
}

async function session(request: Request, env: Env, origin: string): Promise<Response> {
  requireGet(request);
  const current = await userSessionFromRequest(request, env, true);
  return json({ ok: true, user: publicUser(current.principal) }, 200, origin);
}

async function exchangeShareLink(request: Request, env: Env, origin: string): Promise<Response> {
  requirePost(request);
  const limit = await env.SHARE_LINK_LIMITER.limit({ key: await limiterKey(request) });
  if (!limit.success) throw new ApiError("TROP_DE_TENTATIVES", "Trop de tentatives. Attendez une minute avant de réessayer.", 429);
  const input = parse(shareExchangeSchema, await readJson(request, 2_000));
  const tokenHash = await sha256Text(input.token);
  const row = await env.DB.prepare(
    "SELECT id, trainee_id, expires_at FROM access_links WHERE token_hash = ? AND audience = 'TRAINEE' AND revoked_at IS NULL AND expires_at > ?",
  ).bind(tokenHash, new Date().toISOString()).first<{ id: string; trainee_id: string; expires_at: string }>();
  if (!row) throw new ApiError("LIEN_INVALIDE", "Ce lien stagiaire a expiré ou a été révoqué.", 401);
  const expiresAt = Math.floor(Date.parse(row.expires_at) / 1000);
  const token = await createTraineeSessionToken(row.id, row.trainee_id, expiresAt, env.SESSION_SECRET);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("UPDATE access_links SET last_used_at = ? WHERE id = ?").bind(new Date().toISOString(), row.id).run();
  return json({ ok: true, traineeId: row.trainee_id }, 200, origin, { "Set-Cookie": traineeCookie(token, Math.min(30 * 24 * 60 * 60, expiresAt - now)) });
}

async function shareLogout(request: Request, origin: string): Promise<Response> {
  requirePost(request);
  return json({ ok: true }, 200, origin, { "Set-Cookie": clearTraineeCookie() });
}

async function listTrainees(request: Request, env: Env, origin: string): Promise<Response> {
  requireGet(request);
  await userSessionFromRequest(request, env, true);
  const url = new URL(request.url);
  const requestedStatus = url.searchParams.get("status");
  const status = requestedStatus === "OPEN" || requestedStatus === "CLOSED" ? requestedStatus : "";
  const search = (url.searchParams.get("q") || "").trim().slice(0, 100).toLocaleLowerCase("fr");
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (status) { clauses.push("status = ?"); values.push(status); }
  if (search) { clauses.push("(lower(first_name || ' ' || last_name) LIKE ? OR lower(public_ref) LIKE ? OR lower(school) LIKE ?)"); values.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await env.DB.prepare(`SELECT * FROM trainees ${where} ORDER BY CASE status WHEN 'OPEN' THEN 0 ELSE 1 END, start_date DESC, last_name, first_name LIMIT 250`).bind(...values).all<TraineeRow>();
  return json({ ok: true, trainees: result.results.map(row => mapTrainee(row)) }, 200, origin);
}

async function listDirectory(request: Request, env: Env, origin: string): Promise<Response> {
  requireGet(request);
  await userSessionFromRequest(request, env, true);
  const result = await env.DB.prepare("SELECT id, display_name, position, role FROM users WHERE active = 1 ORDER BY last_name, first_name").all<Pick<UserRow, "id" | "display_name" | "position" | "role">>();
  return json({ ok: true, users: result.results.map(user => ({ id: user.id, displayName: user.display_name, position: user.position, role: user.role })) }, 200, origin);
}

async function createTrainee(request: Request, env: Env, origin: string): Promise<Response> {
  requirePost(request);
  const { principal } = await userSessionFromRequest(request, env, true);
  requireRole(principal, ["ADMIN", "CHEF"]);
  const input = parse(traineeCreateSchema, await readJson(request));
  const id = randomId("stg");
  const reference = await nextPublicReference(env, input.startDate.slice(0, 4));
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO trainees
      (id, public_ref, first_name, last_name, email, phone, school, start_date, end_date, tutor_user_id, tutor_name, arrival_notes, status, record_version, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', 1, ?, ?, ?)`,
  ).bind(
    id, reference, input.firstName, input.lastName.toLocaleUpperCase("fr"), input.email, input.phone,
    input.school, input.startDate, input.endDate, input.tutorUserId || null, input.tutorName,
    input.arrivalNotes, principal.id, now, now,
  ).run();
  await audit(env, { traineeId: id, recordVersion: 1, actorType: "USER", actorId: principal.id, actorName: principal.displayName, action: "TRAINEE_CREATED", targetType: "TRAINEE", targetId: id });
  return json({ ok: true, record: publicSnapshot(await getCurrentSnapshot(env, id), principal) }, 201, origin);
}

async function getRecord(request: Request, env: Env, origin: string, id: string): Promise<Response> {
  requireGet(request);
  const access = await recordAccess(request, env, id);
  const snapshot = await getCurrentSnapshot(env, id);
  return json({ ok: true, record: publicSnapshot(snapshot, access.kind === "user" ? access.principal : undefined, access.kind === "trainee") }, 200, origin);
}

async function updateTrainee(request: Request, env: Env, origin: string, id: string): Promise<Response> {
  requirePatch(request);
  const { principal } = await userSessionFromRequest(request, env, true);
  requireRole(principal, ["ADMIN", "CHEF"]);
  const input = parse(traineeUpdateSchema, await readJson(request));
  const trainee = await getTrainee(env, id);
  assertOpenVersion(trainee, input.expectedVersion);
  const resultingStartDate = input.startDate ?? trainee.start_date;
  const resultingEndDate = input.endDate ?? trainee.end_date;
  if (resultingEndDate < resultingStartDate) throw new ApiError("DATES_INCOHERENTES", "La date de fin doit suivre la date de début.", 422);
  const columns: string[] = [];
  const values: unknown[] = [];
  const assign = (column: string, value: unknown): void => { columns.push(`${column} = ?`); values.push(value); };
  if (input.firstName !== undefined) assign("first_name", input.firstName);
  if (input.lastName !== undefined) assign("last_name", input.lastName.toLocaleUpperCase("fr"));
  if (input.email !== undefined) assign("email", input.email);
  if (input.phone !== undefined) assign("phone", input.phone);
  if (input.school !== undefined) assign("school", input.school);
  if (input.startDate !== undefined) assign("start_date", input.startDate);
  if (input.endDate !== undefined) assign("end_date", input.endDate);
  if (input.tutorUserId !== undefined) assign("tutor_user_id", input.tutorUserId || null);
  if (input.tutorName !== undefined) assign("tutor_name", input.tutorName);
  if (input.arrivalNotes !== undefined) assign("arrival_notes", input.arrivalNotes);
  if (columns.length) {
    assign("updated_at", new Date().toISOString());
    await env.DB.prepare(`UPDATE trainees SET ${columns.join(", ")} WHERE id = ? AND status = 'OPEN' AND record_version = ?`).bind(...values, id, input.expectedVersion).run();
    await audit(env, { traineeId: id, recordVersion: trainee.record_version, actorType: "USER", actorId: principal.id, actorName: principal.displayName, action: "TRAINEE_UPDATED", targetType: "TRAINEE", targetId: id, details: { fields: columns.map(value => value.split(" ")[0]) } });
  }
  return json({ ok: true, record: publicSnapshot(await getCurrentSnapshot(env, id), principal) }, 200, origin);
}

async function createShareLink(request: Request, env: Env, origin: string, id: string): Promise<Response> {
  requirePost(request);
  const { principal } = await userSessionFromRequest(request, env, true);
  requireRole(principal, ["ADMIN", "CHEF"]);
  const input = parse(shareLinkSchema, await readJson(request, 2_000));
  const trainee = await getTrainee(env, id);
  const rawToken = randomToken(32);
  const tokenHash = await sha256Text(rawToken);
  const linkId = randomId("lnk");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + input.expiresDays * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO access_links (id, trainee_id, token_hash, audience, expires_at, created_by, created_at)
     VALUES (?, ?, ?, 'TRAINEE', ?, ?, ?)`,
  ).bind(linkId, id, tokenHash, expiresAt, principal.id, now.toISOString()).run();
  await audit(env, { traineeId: id, recordVersion: trainee.record_version, actorType: "USER", actorId: principal.id, actorName: principal.displayName, action: "SHARE_LINK_CREATED", targetType: "ACCESS_LINK", targetId: linkId, details: { expiresAt } });
  return json({
    ok: true,
    link: `${FRONTEND_ORIGIN}/fiche-stagiaire.html?token=${encodeURIComponent(rawToken)}`,
    expiresAt,
    warning: "Ce lien donne accès uniquement à la fiche de ce stagiaire. Il peut être révoqué à tout moment.",
  }, 201, origin);
}

async function revokeShareLinks(request: Request, env: Env, origin: string, id: string): Promise<Response> {
  requireDelete(request);
  const { principal } = await userSessionFromRequest(request, env, true);
  requireRole(principal, ["ADMIN", "CHEF"]);
  const trainee = await getTrainee(env, id);
  const now = new Date().toISOString();
  const result = await env.DB.prepare("UPDATE access_links SET revoked_at = ? WHERE trainee_id = ? AND revoked_at IS NULL").bind(now, id).run();
  await audit(env, { traineeId: id, recordVersion: trainee.record_version, actorType: "USER", actorId: principal.id, actorName: principal.displayName, action: "SHARE_LINKS_REVOKED", targetType: "TRAINEE", targetId: id, details: { changed: result.meta.changes } });
  return noContent(origin);
}

async function createObservation(request: Request, env: Env, origin: string, traineeId: string): Promise<Response> {
  requirePost(request);
  const { principal } = await userSessionFromRequest(request, env, true);
  const input = parse(observationCreateSchema, await readJson(request));
  const trainee = await getTrainee(env, traineeId);
  assertOpenVersion(trainee, input.expectedVersion);
  const id = randomId("obs");
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO observations
      (id, trainee_id, record_version, author_user_id, author_name, category, observed_on, content, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, traineeId, trainee.record_version, principal.id, principal.displayName, input.category, input.observedOn, input.content, now, now).run();
  await audit(env, { traineeId, recordVersion: trainee.record_version, actorType: "USER", actorId: principal.id, actorName: principal.displayName, action: "OBSERVATION_CREATED", targetType: "OBSERVATION", targetId: id, details: { category: input.category, observedOn: input.observedOn } });
  return json({ ok: true, record: publicSnapshot(await getCurrentSnapshot(env, traineeId), principal) }, 201, origin);
}

async function updateObservation(request: Request, env: Env, origin: string, traineeId: string, observationId: string): Promise<Response> {
  requirePatch(request);
  const { principal } = await userSessionFromRequest(request, env, true);
  const input = parse(observationUpdateSchema, await readJson(request));
  const trainee = await getTrainee(env, traineeId);
  assertOpenVersion(trainee, input.expectedVersion);
  const observation = await env.DB.prepare("SELECT * FROM observations WHERE id = ? AND trainee_id = ? AND record_version = ?").bind(observationId, traineeId, trainee.record_version).first<ObservationRow>();
  if (!observation) throw new ApiError("OBSERVATION_INTROUVABLE", "Cette observation n’existe pas.", 404);
  if (observation.author_user_id !== principal.id) throw new ApiError("TEMOIGNAGE_PERSONNEL", "Seul l’auteur peut modifier son observation.", 403);
  const signed = await env.DB.prepare("SELECT id FROM signatures WHERE scope_type = 'OBSERVATION' AND scope_id = ? LIMIT 1").bind(observationId).first();
  if (signed) throw new ApiError("OBSERVATION_SIGNEE_IMMUABLE", "Cette observation est signée et ne peut plus être modifiée.", 409);
  const columns: string[] = [];
  const values: unknown[] = [];
  if (input.category !== undefined) { columns.push("category = ?"); values.push(input.category); }
  if (input.observedOn !== undefined) { columns.push("observed_on = ?"); values.push(input.observedOn); }
  if (input.content !== undefined) { columns.push("content = ?"); values.push(input.content); }
  if (columns.length) {
    columns.push("updated_at = ?"); values.push(new Date().toISOString());
    await env.DB.prepare(`UPDATE observations SET ${columns.join(", ")} WHERE id = ?`).bind(...values, observationId).run();
    await audit(env, { traineeId, recordVersion: trainee.record_version, actorType: "USER", actorId: principal.id, actorName: principal.displayName, action: "OBSERVATION_UPDATED", targetType: "OBSERVATION", targetId: observationId });
  }
  return json({ ok: true, record: publicSnapshot(await getCurrentSnapshot(env, traineeId), principal) }, 200, origin);
}

async function signObservation(request: Request, env: Env, origin: string, traineeId: string, observationId: string): Promise<Response> {
  requirePost(request);
  const { principal } = await userSessionFromRequest(request, env, true);
  const input = parse(signatureSchema, await readJson(request));
  const trainee = await getTrainee(env, traineeId);
  assertOpenVersion(trainee, input.expectedVersion);
  const observation = await env.DB.prepare("SELECT * FROM observations WHERE id = ? AND trainee_id = ? AND record_version = ?").bind(observationId, traineeId, trainee.record_version).first<ObservationRow>();
  if (!observation) throw new ApiError("OBSERVATION_INTROUVABLE", "Cette observation n’existe pas.", 404);
  if (observation.author_user_id !== principal.id) throw new ApiError("TEMOIGNAGE_PERSONNEL", "Vous ne pouvez signer que votre propre observation.", 403);
  const payloadHash = await observationPayloadHash(observation);
  await storeSignature(env, {
    trainee, scopeType: "OBSERVATION", scopeId: observation.id, payloadHash,
    signerUserId: principal.id, signerName: principal.displayName, signerRole: principal.role,
    signatureDataUrl: input.signatureDataUrl,
  });
  await audit(env, { traineeId, recordVersion: trainee.record_version, actorType: "USER", actorId: principal.id, actorName: principal.displayName, action: "OBSERVATION_SIGNED", targetType: "OBSERVATION", targetId: observation.id, details: { payloadHash } });
  return json({ ok: true, record: publicSnapshot(await getCurrentSnapshot(env, traineeId), principal) }, 201, origin);
}

async function saveSelfSection(request: Request, env: Env, origin: string, traineeId: string): Promise<Response> {
  requirePut(request);
  const traineeAccess = await traineeSessionFromRequest(request, env);
  if (traineeAccess.traineeId !== traineeId) throw new ApiError("ACCES_REFUSE", "Ce lien ne donne pas accès à cette fiche.", 403);
  const input = parse(selfSectionSchema, await readJson(request));
  const trainee = await getTrainee(env, traineeId);
  assertOpenVersion(trainee, input.expectedVersion);
  const scopeId = `${traineeId}:${trainee.record_version}`;
  const signed = await env.DB.prepare("SELECT id FROM signatures WHERE scope_type = 'SELF_SECTION' AND scope_id = ? LIMIT 1").bind(scopeId).first();
  if (signed) throw new ApiError("PARTIE_STAGIAIRE_SIGNEE_IMMUABLE", "Votre partie est signée. Elle ne peut plus être modifiée.", 409);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO trainee_self_sections (trainee_id, record_version, expectations, progress, feedback, comments, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(trainee_id, record_version) DO UPDATE SET
       expectations = excluded.expectations, progress = excluded.progress, feedback = excluded.feedback,
       comments = excluded.comments, updated_at = excluded.updated_at`,
  ).bind(traineeId, trainee.record_version, input.expectations, input.progress, input.feedback, input.comments, now).run();
  await audit(env, { traineeId, recordVersion: trainee.record_version, actorType: "TRAINEE", actorId: traineeAccess.linkId, actorName: `${trainee.first_name} ${trainee.last_name}`, action: "SELF_SECTION_UPDATED", targetType: "SELF_SECTION", targetId: scopeId });
  return json({ ok: true, record: publicSnapshot(await getCurrentSnapshot(env, traineeId), undefined, true) }, 200, origin);
}

async function signSelfSection(request: Request, env: Env, origin: string, traineeId: string): Promise<Response> {
  requirePost(request);
  const traineeAccess = await traineeSessionFromRequest(request, env);
  if (traineeAccess.traineeId !== traineeId) throw new ApiError("ACCES_REFUSE", "Ce lien ne donne pas accès à cette fiche.", 403);
  const input = parse(signatureSchema, await readJson(request));
  const trainee = await getTrainee(env, traineeId);
  assertOpenVersion(trainee, input.expectedVersion);
  const row = await env.DB.prepare("SELECT * FROM trainee_self_sections WHERE trainee_id = ? AND record_version = ?").bind(traineeId, trainee.record_version).first<SelfSectionRow>();
  if (!row) throw new ApiError("PARTIE_STAGIAIRE_VIDE", "Complétez votre partie avant de la signer.", 409);
  if (![row.expectations, row.progress, row.feedback, row.comments].some(Boolean)) throw new ApiError("PARTIE_STAGIAIRE_VIDE", "Complétez votre partie avant de la signer.", 409);
  const payloadHash = await selfSectionPayloadHash(row);
  const scopeId = `${traineeId}:${trainee.record_version}`;
  const signerName = `${trainee.first_name} ${trainee.last_name}`.trim();
  await storeSignature(env, {
    trainee, scopeType: "SELF_SECTION", scopeId, payloadHash,
    signerUserId: null, signerName, signerRole: "TRAINEE", signatureDataUrl: input.signatureDataUrl,
  });
  await audit(env, { traineeId, recordVersion: trainee.record_version, actorType: "TRAINEE", actorId: traineeAccess.linkId, actorName: signerName, action: "SELF_SECTION_SIGNED", targetType: "SELF_SECTION", targetId: scopeId, details: { payloadHash } });
  return json({ ok: true, record: publicSnapshot(await getCurrentSnapshot(env, traineeId), undefined, true) }, 201, origin);
}

async function saveFinalEvaluation(request: Request, env: Env, origin: string, traineeId: string): Promise<Response> {
  requirePut(request);
  const { principal } = await userSessionFromRequest(request, env, true);
  requireRole(principal, ["ADMIN", "CHEF"]);
  const input = parse(finalEvaluationSchema, await readJson(request));
  const trainee = await getTrainee(env, traineeId);
  assertOpenVersion(trainee, input.expectedVersion);
  const existing = await env.DB.prepare("SELECT * FROM final_evaluations WHERE trainee_id = ? AND record_version = ?").bind(traineeId, trainee.record_version).first<FinalEvaluationRow>();
  if (existing) {
    const signed = await env.DB.prepare("SELECT id FROM signatures WHERE scope_type = 'FINAL_EVALUATION' AND scope_id = ? LIMIT 1").bind(existing.id).first();
    if (signed) throw new ApiError("EVALUATION_SIGNEE_IMMUABLE", "L’évaluation est signée et ne peut plus être modifiée.", 409);
  }
  const id = existing?.id || randomId("eval");
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO final_evaluations
      (id, trainee_id, record_version, ratings_json, strengths, improvements, summary, status, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?)
     ON CONFLICT(trainee_id, record_version) DO UPDATE SET
       ratings_json = excluded.ratings_json, strengths = excluded.strengths,
       improvements = excluded.improvements, summary = excluded.summary,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).bind(id, traineeId, trainee.record_version, JSON.stringify(input.ratings), input.strengths, input.improvements, input.summary, principal.id, existing?.created_at || now, now).run();
  await audit(env, { traineeId, recordVersion: trainee.record_version, actorType: "USER", actorId: principal.id, actorName: principal.displayName, action: existing ? "FINAL_EVALUATION_UPDATED" : "FINAL_EVALUATION_CREATED", targetType: "FINAL_EVALUATION", targetId: id });
  return json({ ok: true, record: publicSnapshot(await getCurrentSnapshot(env, traineeId), principal) }, existing ? 200 : 201, origin);
}

async function signFinalEvaluation(request: Request, env: Env, origin: string, traineeId: string): Promise<Response> {
  requirePost(request);
  const input = parse(signatureSchema, await readJson(request));
  const access = await recordAccess(request, env, traineeId);
  const trainee = await getTrainee(env, traineeId);
  assertOpenVersion(trainee, input.expectedVersion);
  const evaluation = await env.DB.prepare("SELECT * FROM final_evaluations WHERE trainee_id = ? AND record_version = ?").bind(traineeId, trainee.record_version).first<FinalEvaluationRow>();
  if (!evaluation) throw new ApiError("EVALUATION_FINALE_MANQUANTE", "L’évaluation finale doit être remplie avant signature.", 409);
  const payloadHash = await finalEvaluationPayloadHash(evaluation);
  let signerUserId: string | null;
  let signerName: string;
  let signerRole: string;
  let actorType: "USER" | "TRAINEE";
  let actorId: string;
  if (access.kind === "user") {
    const tutor = trainee.tutor_user_id === access.principal.id;
    if (!tutor && !["ADMIN", "CHEF"].includes(access.principal.role)) throw new ApiError("ACCES_REFUSE", "Seul le tuteur désigné ou un responsable peut signer cette évaluation.", 403);
    signerUserId = access.principal.id;
    signerName = access.principal.displayName;
    signerRole = tutor && access.principal.role === "AGENT" ? "TUTOR" : access.principal.role;
    actorType = "USER";
    actorId = access.principal.id;
  } else {
    signerUserId = null;
    signerName = `${trainee.first_name} ${trainee.last_name}`.trim();
    signerRole = "TRAINEE";
    actorType = "TRAINEE";
    actorId = access.linkId;
  }
  await storeSignature(env, {
    trainee, scopeType: "FINAL_EVALUATION", scopeId: evaluation.id, payloadHash,
    signerUserId, signerName, signerRole, signatureDataUrl: input.signatureDataUrl,
  });
  await audit(env, { traineeId, recordVersion: trainee.record_version, actorType, actorId, actorName: signerName, action: "FINAL_EVALUATION_SIGNED", targetType: "FINAL_EVALUATION", targetId: evaluation.id, details: { payloadHash, signerRole } });
  return json({ ok: true, record: publicSnapshot(await getCurrentSnapshot(env, traineeId), access.kind === "user" ? access.principal : undefined, access.kind === "trainee") }, 201, origin);
}

async function closeRecord(request: Request, env: Env, origin: string, traineeId: string): Promise<Response> {
  requirePost(request);
  const { principal } = await userSessionFromRequest(request, env, true);
  requireRole(principal, ["ADMIN", "CHEF"]);
  const input = parse(closeSchema, await readJson(request, 2_000));
  const snapshot = await getCurrentSnapshot(env, traineeId);
  assertOpenVersion(snapshot.trainee, input.expectedVersion);
  if (!snapshot.finalEvaluation) throw new ApiError("EVALUATION_FINALE_MANQUANTE", "Complétez l’évaluation finale avant de clôturer.", 409);

  const finalHash = await finalEvaluationPayloadHash(snapshot.finalEvaluation);
  const finalSignatures = snapshot.signatures.filter(signature =>
    signature.scope_type === "FINAL_EVALUATION" &&
    signature.scope_id === snapshot.finalEvaluation?.id &&
    signature.payload_hash === finalHash,
  );
  if (!finalSignatures.some(signature => signature.signer_role === "ADMIN" || signature.signer_role === "CHEF")) {
    throw new ApiError("SIGNATURE_RESPONSABLE_MANQUANTE", "La signature finale d’un responsable est nécessaire.", 409);
  }
  if (!finalSignatures.some(signature => signature.signer_role === "TRAINEE")) {
    throw new ApiError("SIGNATURE_STAGIAIRE_MANQUANTE", "L’attestation de prise de connaissance du stagiaire est nécessaire.", 409);
  }

  const unsignedAuthors: string[] = [];
  for (const observation of snapshot.observations) {
    const hash = await observationPayloadHash(observation);
    const valid = snapshot.signatures.some(signature =>
      signature.scope_type === "OBSERVATION" && signature.scope_id === observation.id &&
      signature.payload_hash === hash && signature.signer_user_id === observation.author_user_id,
    );
    if (!valid) unsignedAuthors.push(`${observation.author_name} (${observation.observed_on})`);
  }
  if (unsignedAuthors.length) {
    throw new ApiError("OBSERVATIONS_NON_SIGNEES", "Toutes les observations incluses doivent être signées par leur auteur.", 409, { observations: unsignedAuthors });
  }

  if (snapshot.selfSection && [snapshot.selfSection.expectations, snapshot.selfSection.progress, snapshot.selfSection.feedback, snapshot.selfSection.comments].some(Boolean)) {
    const selfHash = await selfSectionPayloadHash(snapshot.selfSection);
    const valid = snapshot.signatures.some(signature => signature.scope_type === "SELF_SECTION" && signature.scope_id === `${traineeId}:${snapshot.trainee.record_version}` && signature.payload_hash === selfHash && signature.signer_role === "TRAINEE");
    if (!valid) throw new ApiError("PARTIE_STAGIAIRE_NON_SIGNEE", "La partie remplie par le stagiaire doit être signée avant clôture.", 409);
  }

  const signatureImages = new Map<string, Uint8Array>();
  await Promise.all(snapshot.signatures.map(async signature => {
    const object = await env.DOCUMENTS.get(signature.signature_object_key);
    if (object) signatureImages.set(signature.id, new Uint8Array(await object.arrayBuffer()));
  }));
  const pdfBytes = await generateFinalPdf(snapshot, signatureImages);
  const pdfHash = await sha256Bytes(pdfBytes);
  const documentId = randomId("doc");
  const objectKey = `stagiaires/${safeFilename(snapshot.trainee.public_ref)}/v${snapshot.trainee.record_version}/${pdfHash.slice(0, 24)}.pdf`;
  const now = new Date().toISOString();
  const { documents: _documents, ...recordSnapshot } = snapshot;
  const immutableSnapshot = {
    ...recordSnapshot,
    trainee: { ...snapshot.trainee, status: "CLOSED", closed_at: now, updated_at: now },
    finalEvaluation: { ...snapshot.finalEvaluation, status: "CLOSED", closed_at: now, updated_at: now },
  };
  await env.DOCUMENTS.put(objectKey, pdfBytes, {
    httpMetadata: {
      contentType: "application/pdf",
      contentDisposition: `attachment; filename="${safeFilename(`suivi-stage-${snapshot.trainee.public_ref}-v${snapshot.trainee.record_version}`)}.pdf"`,
      cacheControl: "private, no-store",
    },
    customMetadata: {
      traineeId,
      reference: snapshot.trainee.public_ref,
      version: String(snapshot.trainee.record_version),
      sha256: pdfHash,
    },
  });
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO documents (id, trainee_id, record_version, object_key, sha256, byte_length, snapshot_json, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(documentId, traineeId, snapshot.trainee.record_version, objectKey, pdfHash, pdfBytes.byteLength, stableStringify(immutableSnapshot), principal.id, now),
      env.DB.prepare(
        "UPDATE final_evaluations SET status = 'CLOSED', closed_at = ?, updated_at = ? WHERE id = ? AND status = 'DRAFT'",
      ).bind(now, now, snapshot.finalEvaluation.id),
      env.DB.prepare(
        "UPDATE trainees SET status = 'CLOSED', closed_at = ?, updated_at = ? WHERE id = ? AND status = 'OPEN' AND record_version = ?",
      ).bind(now, now, traineeId, snapshot.trainee.record_version),
      auditStatement(env, { traineeId, recordVersion: snapshot.trainee.record_version, actorType: "USER", actorId: principal.id, actorName: principal.displayName, action: "RECORD_CLOSED", targetType: "DOCUMENT", targetId: documentId, details: { sha256: pdfHash, objectKey } }),
    ]);
  } catch (error) {
    await env.DOCUMENTS.delete(objectKey);
    throw error;
  }
  return json({
    ok: true,
    document: {
      id: documentId,
      version: snapshot.trainee.record_version,
      sha256: pdfHash,
      byteLength: pdfBytes.byteLength,
      downloadUrl: `/v2/trainees/${traineeId}/documents/${snapshot.trainee.record_version}`,
    },
    record: publicSnapshot(await getCurrentSnapshot(env, traineeId), principal),
  }, 201, origin);
}

async function createNewVersion(request: Request, env: Env, origin: string, traineeId: string): Promise<Response> {
  requirePost(request);
  const { principal } = await userSessionFromRequest(request, env, true);
  requireRole(principal, ["ADMIN", "CHEF"]);
  const input = parse(newVersionSchema, await readJson(request, 2_000));
  const trainee = await getTrainee(env, traineeId);
  if (trainee.status !== "CLOSED") throw new ApiError("DOSSIER_NON_CLOTURE", "Une nouvelle version se crée uniquement après clôture.", 409);
  if (trainee.record_version !== input.expectedVersion) throw new ApiError("VERSION_DEPASSEE", "La fiche a déjà changé de version.", 409, { currentVersion: trainee.record_version });
  const previousVersion = trainee.record_version;
  const newVersion = previousVersion + 1;
  const newEvaluationId = randomId("eval");
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE trainees SET status = 'OPEN', record_version = ?, closed_at = NULL, updated_at = ? WHERE id = ? AND status = 'CLOSED' AND record_version = ?",
    ).bind(newVersion, now, traineeId, previousVersion),
    env.DB.prepare(
      `INSERT INTO trainee_self_sections (trainee_id, record_version, expectations, progress, feedback, comments, updated_at)
       SELECT trainee_id, ?, expectations, progress, feedback, comments, ?
       FROM trainee_self_sections WHERE trainee_id = ? AND record_version = ?`,
    ).bind(newVersion, now, traineeId, previousVersion),
    env.DB.prepare(
      `INSERT INTO final_evaluations
        (id, trainee_id, record_version, ratings_json, strengths, improvements, summary, status, updated_by, created_at, updated_at)
       SELECT ?, trainee_id, ?, ratings_json, strengths, improvements, summary, 'DRAFT', ?, ?, ?
       FROM final_evaluations WHERE trainee_id = ? AND record_version = ?`,
    ).bind(newEvaluationId, newVersion, principal.id, now, now, traineeId, previousVersion),
    auditStatement(env, { traineeId, recordVersion: newVersion, actorType: "USER", actorId: principal.id, actorName: principal.displayName, action: "NEW_RECORD_VERSION", targetType: "TRAINEE", targetId: traineeId, details: { previousVersion, newVersion } }),
  ]);
  return json({ ok: true, record: publicSnapshot(await getCurrentSnapshot(env, traineeId), principal) }, 201, origin);
}

async function downloadDocument(request: Request, env: Env, origin: string, traineeId: string, version: number): Promise<Response> {
  requireGet(request);
  await recordAccess(request, env, traineeId);
  const row = await env.DB.prepare("SELECT object_key, sha256 FROM documents WHERE trainee_id = ? AND record_version = ?").bind(traineeId, version).first<{ object_key: string; sha256: string }>();
  if (!row) throw new ApiError("DOCUMENT_INTROUVABLE", "Ce document définitif n’existe pas.", 404);
  const object = await env.DOCUMENTS.get(row.object_key);
  if (!object) throw new ApiError("DOCUMENT_ARCHIVE_INDISPONIBLE", "Le document archivé est temporairement indisponible.", 503);
  const trainee = await getTrainee(env, traineeId);
  const headers = new Headers({
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="${safeFilename(`suivi-stage-${trainee.public_ref}-v${version}`)}.pdf"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Document-SHA256": row.sha256,
    "Cross-Origin-Resource-Policy": "same-site",
    Vary: "Origin",
  });
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
  }
  return new Response(object.body, { status: 200, headers });
}

async function listUsers(request: Request, env: Env, origin: string): Promise<Response> {
  requireGet(request);
  const { principal } = await userSessionFromRequest(request, env, true);
  requireRole(principal, ["ADMIN"]);
  const result = await env.DB.prepare(
    "SELECT id, first_name, last_name, display_name, position, role, permissions_json, active, created_at, updated_at FROM users ORDER BY active DESC, role, last_name, first_name",
  ).all<Pick<UserRow, "id" | "first_name" | "last_name" | "display_name" | "position" | "role" | "permissions_json" | "active"> & { created_at: string; updated_at: string }>();
  return json({
    ok: true,
    users: result.results.map(row => ({
      id: row.id,
      firstName: row.first_name,
      lastName: row.last_name,
      displayName: row.display_name,
      position: row.position,
      role: row.role,
      permissions: parseJsonObject(row.permissions_json),
      active: row.active === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  }, 200, origin);
}

async function createUser(request: Request, env: Env, origin: string): Promise<Response> {
  requirePost(request);
  const { principal } = await userSessionFromRequest(request, env, true);
  requireRole(principal, ["ADMIN"]);
  const input = parse(userCreateSchema, await readJson(request));
  const user = await insertUser(env, input);
  await audit(env, { actorType: "USER", actorId: principal.id, actorName: principal.displayName, action: "USER_CREATED", targetType: "USER", targetId: user.id, details: { role: user.role } });
  return json({ ok: true, user: publicUser(principalFromUserRow(user)) }, 201, origin);
}

async function updateUser(request: Request, env: Env, origin: string, userId: string): Promise<Response> {
  requirePatch(request);
  const { principal } = await userSessionFromRequest(request, env, true);
  requireRole(principal, ["ADMIN"]);
  const input = parse(userUpdateSchema, await readJson(request));
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<UserRow>();
  if (!user) throw new ApiError("UTILISATEUR_INTROUVABLE", "Cet utilisateur n’existe pas.", 404);
  const demotesAdmin = user.role === "ADMIN" && (input.role && input.role !== "ADMIN" || input.active === false);
  if (demotesAdmin) {
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'ADMIN' AND active = 1").first<{ count: number }>();
    if (Number(count?.count || 0) <= 1) throw new ApiError("DERNIER_ADMINISTRATEUR", "Le dernier administrateur actif ne peut pas être désactivé.", 409);
  }
  const columns: string[] = [];
  const values: unknown[] = [];
  const assign = (column: string, value: unknown): void => { columns.push(`${column} = ?`); values.push(value); };
  if (input.firstName !== undefined && input.firstName !== user.first_name) assign("first_name", input.firstName);
  if (input.lastName !== undefined && input.lastName.toLocaleUpperCase("fr") !== user.last_name) assign("last_name", input.lastName.toLocaleUpperCase("fr"));
  if (input.position !== undefined && input.position !== user.position) assign("position", input.position);
  if (input.role !== undefined && input.role !== user.role) assign("role", input.role);
  if (input.permissions !== undefined && JSON.stringify(input.permissions) !== user.permissions_json) assign("permissions_json", JSON.stringify(input.permissions));
  if (input.active !== undefined && (input.active ? 1 : 0) !== user.active) assign("active", input.active ? 1 : 0);
  const nextDisplayName = `${input.firstName ?? user.first_name} ${(input.lastName ?? user.last_name).toLocaleUpperCase("fr")}`.trim();
  if (nextDisplayName !== user.display_name) assign("display_name", nextDisplayName);
  if (input.pin !== undefined) {
    const credentials = await pinCredentials(input.pin, env.SESSION_SECRET);
    assign("pin_lookup", credentials.pinLookup);
    assign("pin_salt", credentials.pinSalt);
    assign("pin_hash", credentials.pinHash);
    assign("pin_iterations", credentials.pinIterations);
  }
  if (!columns.length) return json({ ok: true, user: publicUser(principalFromUserRow(user)) }, 200, origin);
  assign("session_version", randomToken());
  assign("updated_at", new Date().toISOString());
  try {
    await env.DB.prepare(`UPDATE users SET ${columns.join(", ")} WHERE id = ?`).bind(...values, userId).run();
  } catch (error) {
    if (/UNIQUE|pin_lookup/i.test(error instanceof Error ? error.message : String(error))) throw new ApiError("CODE_DEJA_UTILISE", "Ce code est déjà attribué à une autre personne.", 409);
    throw error;
  }
  await audit(env, { actorType: "USER", actorId: principal.id, actorName: principal.displayName, action: "USER_UPDATED", targetType: "USER", targetId: userId, details: { fields: columns.map(value => value.split(" ")[0]) } });
  const updated = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<UserRow>();
  if (!updated) throw new ApiError("UTILISATEUR_INTROUVABLE", "Cet utilisateur n’existe plus.", 404);
  return json({ ok: true, user: publicUser(principalFromUserRow(updated)) }, 200, origin);
}

async function insertUser(env: Env, input: z.infer<typeof userCreateSchema> | z.infer<typeof bootstrapSchema>): Promise<UserRow> {
  const credentials = await pinCredentials(input.pin, env.SESSION_SECRET);
  const id = randomId("usr");
  const now = new Date().toISOString();
  const lastName = input.lastName.toLocaleUpperCase("fr");
  try {
    await env.DB.prepare(
      `INSERT INTO users
        (id, first_name, last_name, display_name, position, role, permissions_json, pin_lookup, pin_salt, pin_hash, pin_iterations, session_version, legacy_access_version, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 1, ?, ?)`,
    ).bind(
      id, input.firstName, lastName, `${input.firstName} ${lastName}`.trim(), input.position,
      input.role, JSON.stringify(input.permissions), credentials.pinLookup, credentials.pinSalt,
      credentials.pinHash, credentials.pinIterations, randomToken(), now, now,
    ).run();
  } catch (error) {
    if (/UNIQUE|pin_lookup/i.test(error instanceof Error ? error.message : String(error))) throw new ApiError("CODE_DEJA_UTILISE", "Ce code est déjà attribué à une autre personne.", 409);
    throw error;
  }
  const row = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
  if (!row) throw new Error("USER_INSERT_FAILED");
  return row;
}

async function storeSignature(env: Env, input: {
  trainee: TraineeRow;
  scopeType: "OBSERVATION" | "SELF_SECTION" | "FINAL_EVALUATION";
  scopeId: string;
  payloadHash: string;
  signerUserId: string | null;
  signerName: string;
  signerRole: string;
  signatureDataUrl: string;
}): Promise<SignatureRow> {
  const duplicate = await env.DB.prepare(
    `SELECT id FROM signatures
     WHERE scope_type = ? AND scope_id = ? AND signer_role = ? AND COALESCE(signer_user_id, '') = COALESCE(?, '') LIMIT 1`,
  ).bind(input.scopeType, input.scopeId, input.signerRole, input.signerUserId).first();
  if (duplicate) throw new ApiError("SIGNATURE_EXISTANTE", "Cette partie est déjà signée par cette personne.", 409);
  const bytes = decodePngDataUrl(input.signatureDataUrl);
  const signatureHash = await sha256Bytes(bytes);
  const id = randomId("sig");
  const objectKey = `signatures/${input.trainee.id}/v${input.trainee.record_version}/${input.scopeType.toLowerCase()}/${id}.png`;
  const now = new Date().toISOString();
  await env.DOCUMENTS.put(objectKey, bytes, {
    httpMetadata: { contentType: "image/png", cacheControl: "private, no-store" },
    customMetadata: { traineeId: input.trainee.id, version: String(input.trainee.record_version), scopeType: input.scopeType, sha256: signatureHash },
  });
  try {
    await env.DB.prepare(
      `INSERT INTO signatures
        (id, trainee_id, record_version, scope_type, scope_id, payload_hash, signer_user_id, signer_name, signer_role, signature_object_key, signature_sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, input.trainee.id, input.trainee.record_version, input.scopeType, input.scopeId,
      input.payloadHash, input.signerUserId, input.signerName, input.signerRole,
      objectKey, signatureHash, now,
    ).run();
  } catch (error) {
    await env.DOCUMENTS.delete(objectKey);
    if (/UNIQUE/i.test(error instanceof Error ? error.message : String(error))) throw new ApiError("SIGNATURE_EXISTANTE", "Cette partie est déjà signée par cette personne.", 409);
    throw error;
  }
  const row = await env.DB.prepare("SELECT * FROM signatures WHERE id = ?").bind(id).first<SignatureRow>();
  if (!row) throw new Error("SIGNATURE_INSERT_FAILED");
  return row;
}

function decodePngDataUrl(value: string): Uint8Array {
  const encoded = value.slice(value.indexOf(",") + 1).replace(/\s/g, "");
  let binary: string;
  try { binary = atob(encoded); }
  catch { throw new ApiError("SIGNATURE_INVALIDE", "La signature est illisible.", 422); }
  if (binary.length < 60 || binary.length > MAX_SIGNATURE_BYTES) throw new ApiError("SIGNATURE_INVALIDE", "La signature est vide ou trop volumineuse.", 422);
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  const pngHeader = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!pngHeader.every((byte, index) => bytes[index] === byte)) throw new ApiError("SIGNATURE_INVALIDE", "Le fichier de signature n’est pas une image PNG valide.", 422);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (!width || !height || width > 2500 || height > 1200 || width * height > 3_000_000) throw new ApiError("SIGNATURE_INVALIDE", "Les dimensions de la signature sont invalides.", 422);
  return bytes;
}

async function recordAccess(request: Request, env: Env, traineeId: string): Promise<RecordAccess> {
  try {
    const user = await userSessionFromRequest(request, env, true);
    return { kind: "user", principal: user.principal };
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
  }
  const trainee = await traineeSessionFromRequest(request, env);
  if (trainee.traineeId !== traineeId) throw new ApiError("ACCES_REFUSE", "Ce lien ne donne pas accès à cette fiche.", 403);
  return { kind: "trainee", traineeId, linkId: trainee.linkId };
}

async function nextPublicReference(env: Env, year: string): Promise<string> {
  const prefix = `STG-${year}-`;
  const row = await env.DB.prepare("SELECT public_ref FROM trainees WHERE public_ref LIKE ? ORDER BY public_ref DESC LIMIT 1").bind(`${prefix}%`).first<{ public_ref: string }>();
  const last = row ? Number(row.public_ref.slice(prefix.length)) : 0;
  for (let offset = 1; offset <= 20; offset += 1) {
    const candidate = `${prefix}${String(last + offset).padStart(4, "0")}`;
    const exists = await env.DB.prepare("SELECT 1 FROM trainees WHERE public_ref = ?").bind(candidate).first();
    if (!exists) return candidate;
  }
  return `${prefix}${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

function auditStatement(env: Env, input: {
  traineeId?: string;
  recordVersion?: number;
  actorType: "USER" | "TRAINEE" | "SYSTEM";
  actorId: string;
  actorName: string;
  action: string;
  targetType: string;
  targetId: string;
  details?: Record<string, unknown>;
}): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO audit_events
      (id, trainee_id, record_version, actor_type, actor_id, actor_name, action, target_type, target_id, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    randomId("evt"), input.traineeId || null, input.recordVersion || null, input.actorType,
    input.actorId, input.actorName, input.action, input.targetType, input.targetId,
    JSON.stringify(input.details || {}), new Date().toISOString(),
  );
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw validationError(result.error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message })));
  return result.data;
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && !Array.isArray(parsed) && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

function requireGet(request: Request): void { if (request.method !== "GET") throw new ApiError("METHODE_REFUSEE", "Méthode non autorisée.", 405); }
function requirePost(request: Request): void { if (request.method !== "POST") throw new ApiError("METHODE_REFUSEE", "Méthode non autorisée.", 405); }
function requirePut(request: Request): void { if (request.method !== "PUT") throw new ApiError("METHODE_REFUSEE", "Méthode non autorisée.", 405); }
function requirePatch(request: Request): void { if (request.method !== "PATCH") throw new ApiError("METHODE_REFUSEE", "Méthode non autorisée.", 405); }
function requireDelete(request: Request): void { if (request.method !== "DELETE") throw new ApiError("METHODE_REFUSEE", "Méthode non autorisée.", 405); }
