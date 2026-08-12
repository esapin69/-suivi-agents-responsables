import type { AccessMap, Env, Principal } from "./types";
import { ApiError, readJson } from "./http";
import {
  createUserSessionToken,
  inferRole,
  publicUser,
  randomId,
  userCookie,
  userSessionFromRequest,
  type UserSession,
} from "./security";

export const LEGACY_GET_ACTIONS = new Set([
  "listAgents",
  "listDirectory",
  "getAgent",
  "getFirstDay",
  "listEvaluations",
  "getEvaluation",
]);

export const LEGACY_POST_ACTIONS = new Set([
  "createAgent",
  "updateAgent",
  "saveFirstDay",
  "saveEvaluationDraft",
  "finalizeEvaluation",
  "submitSituation",
]);

type LegacyAuthUser = {
  id: string;
  nom: string;
  prenom: string;
  poste: string;
  display_name: string;
  is_admin: boolean;
  access: AccessMap;
};

export async function authenticateWithPin(env: Env, pin: string): Promise<{ principal: Principal; legacyAccessVersion: string; cookie: string }> {
  if (!env.APPS_SCRIPT_URL || !env.APPS_SCRIPT_KEY) {
    throw new ApiError("CODE_INVALIDE", "Code incorrect ou accès non autorisé.", 401);
  }
  const result = await callAppsScript(env, "POST", "authenticateAccess", { code: pin }, {});
  const user = validateLegacyAuthUser(result.user);
  const accessVersion = String(result.session_version || "");
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(accessVersion)) throw new ApiError("AUTH_INVALIDE", "Identité invalide.", 401);
  const principal = principalFromLegacyUser(user, accessVersion);
  await syncIdentityMirror(env, principal);
  const token = await createUserSessionToken(principal, accessVersion, env.SESSION_SECRET);
  return { principal, legacyAccessVersion: accessVersion, cookie: userCookie(token) };
}

export async function authorizedUserSessionFromRequest(request: Request, env: Env): Promise<UserSession> {
  const session = await userSessionFromRequest(request, env);
  if (!session.legacyAccessVersion) throw new ApiError("AUTH_REQUISE", "Votre session a expiré. Reconnectez-vous.", 401);
  const result = await callAppsScript(env, "GET", "authorizeAccess", {}, {
    auth_user_id: session.principal.id,
    auth_session_version: session.legacyAccessVersion,
  });
  const user = validateLegacyAuthUser(result.user);
  if (user.id !== session.principal.id) throw new ApiError("AUTH_INVALIDE", "Identité invalide.", 401);
  const principal = principalFromLegacyUser(user, session.legacyAccessVersion);
  await syncIdentityMirror(env, principal);
  return { principal, legacyAccessVersion: session.legacyAccessVersion };
}

export async function proxyLegacyAction(request: Request, env: Env, action: string): Promise<Record<string, unknown>> {
  if (!env.APPS_SCRIPT_URL || !env.APPS_SCRIPT_KEY) {
    throw new ApiError("ANCIEN_SERVICE_INDISPONIBLE", "Cette ancienne rubrique est en cours de migration.", 503);
  }
  const session = await userSessionFromRequest(request, env);
  if (!session.legacyAccessVersion) {
    throw new ApiError("ANCIEN_SERVICE_RECONNEXION", "Reconnectez-vous avant d’utiliser cette ancienne rubrique.", 401);
  }
  if (request.method === "GET") {
    if (!LEGACY_GET_ACTIONS.has(action)) throw new ApiError("ACTION_REFUSEE", "Action non autorisée.", 403);
    const url = new URL(request.url);
    const params: Record<string, string> = {
      auth_user_id: session.principal.id,
      auth_session_version: session.legacyAccessVersion,
    };
    const id = url.searchParams.get("id");
    if (id) params.id = id;
    return callAppsScript(env, "GET", action, {}, params);
  }
  if (request.method === "POST") {
    if (!LEGACY_POST_ACTIONS.has(action)) throw new ApiError("ACTION_REFUSEE", "Action non autorisée.", 403);
    const payload = await readJson(request);
    payload.auth_user_id = session.principal.id;
    payload.auth_session_version = session.legacyAccessVersion;
    if (action === "saveFirstDay") payload.chef_nom = session.principal.displayName;
    if (action === "saveEvaluationDraft" || action === "finalizeEvaluation") payload.evaluateur = session.principal.displayName;
    return callAppsScript(env, "POST", action, payload, {});
  }
  throw new ApiError("METHODE_REFUSEE", "Méthode non autorisée.", 405);
}

export async function callAppsScript(
  env: Env,
  method: "GET" | "POST",
  action: string,
  payload: Record<string, unknown>,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  if (!env.APPS_SCRIPT_URL || !env.APPS_SCRIPT_KEY) throw new ApiError("SERVICE_GOOGLE_MANQUANT", "Ancien service indisponible.", 503);
  let response: Response;
  if (method === "GET") {
    const url = new URL(env.APPS_SCRIPT_URL);
    url.searchParams.set("key", env.APPS_SCRIPT_KEY);
    url.searchParams.set("action", action);
    for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
    response = await fetch(url.toString(), { method: "GET", redirect: "follow" });
  } else {
    const body = new URLSearchParams();
    body.set("payload", JSON.stringify({ ...payload, action, key: env.APPS_SCRIPT_KEY }));
    response = await fetch(env.APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body,
      redirect: "follow",
    });
  }
  const raw = await response.text();
  let data: Record<string, unknown>;
  try { data = JSON.parse(raw) as Record<string, unknown>; }
  catch { throw new ApiError("REPONSE_GOOGLE_INVALIDE", "L’ancien service a renvoyé une réponse invalide.", 502); }
  if (data.ok === false) {
    const code = String(data.code || "ERREUR_GOOGLE");
    const authentication = /AUTH|CODE|ACCES/.test(code);
    throw new ApiError(code, authentication ? "Code incorrect ou accès non autorisé." : String(data.message || "L’ancien service a refusé la demande."), authentication ? 401 : 400);
  }
  return data;
}

function principalFromLegacyUser(user: LegacyAuthUser, accessVersion: string): Principal {
  const role = inferRole(user.is_admin, user.poste);
  return {
    id: user.id,
    firstName: user.prenom,
    lastName: user.nom,
    displayName: user.display_name,
    position: user.poste,
    role,
    source: "legacy",
    sessionVersion: accessVersion,
    access: { ...user.access },
  };
}

async function syncIdentityMirror(env: Env, principal: Principal): Promise<void> {
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO users
        (id, first_name, last_name, display_name, position, role, permissions_json, last_verified_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
        first_name = excluded.first_name, last_name = excluded.last_name, display_name = excluded.display_name,
        position = excluded.position, role = excluded.role, permissions_json = excluded.permissions_json,
        last_verified_at = excluded.last_verified_at, updated_at = excluded.updated_at`,
    ).bind(
      principal.id, principal.firstName, principal.lastName, principal.displayName, principal.position,
      principal.role, JSON.stringify(principal.access), now, now, now,
    ).run();
  } catch (error) {
    console.warn(JSON.stringify({ event: "identity_mirror_sync_failed", message: error instanceof Error ? error.message : String(error) }));
  }
}

function validateLegacyAuthUser(value: unknown): LegacyAuthUser {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new ApiError("AUTH_INVALIDE", "Identité invalide.", 401);
  const source = value as Record<string, unknown>;
  const user: LegacyAuthUser = {
    id: String(source.id || ""),
    nom: String(source.nom || ""),
    prenom: String(source.prenom || ""),
    poste: String(source.poste || ""),
    display_name: String(source.display_name || ""),
    is_admin: source.is_admin === true,
    access: normalizeAccess(source.access),
  };
  if (!user.id || !user.nom || !user.prenom || !user.display_name) throw new ApiError("AUTH_INVALIDE", "Identité incomplète.", 401);
  return user;
}

function normalizeAccess(value: unknown): AccessMap {
  if (!value || Array.isArray(value) || typeof value !== "object") return {};
  const result: AccessMap = {};
  for (const [key, allowed] of Object.entries(value as Record<string, unknown>)) {
    if (/^[a-z0-9_]{1,80}$/.test(key) && typeof allowed === "boolean") result[key] = allowed;
  }
  return result;
}

export function publicAuthenticatedUser(principal: Principal): Record<string, unknown> {
  return publicUser(principal);
}

export function auditLoginId(): string {
  return randomId("login");
}
