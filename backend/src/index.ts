const ALLOWED_ORIGIN = "https://responsable.esapin.com";
const SESSION_COOKIE = "__Host-ghe_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const MAX_BODY_BYTES = 250_000;
const MAX_LOGIN_BODY_BYTES = 2_000;
const LEGACY_SITUATION_FORM_URL =
  "https://docs.google.com/forms/d/e/1FAIpQLSefNyx7HzdDw2Mq17DEVNDVOu-jWq1I-E4D9xvxOmlz_-QVFw/formResponse";

const GET_ACTIONS = new Set([
  "listAgents",
  "listDirectory",
  "getAgent",
  "getFirstDay",
  "listEvaluations",
  "getEvaluation",
]);

const POST_ACTIONS = new Set([
  "createAgent",
  "updateAgent",
  "saveFirstDay",
  "saveEvaluationDraft",
  "finalizeEvaluation",
  "submitSituation",
]);

type AuthUser = {
  id: string;
  nom: string;
  prenom: string;
  poste: string;
  display_name: string;
  is_admin: boolean;
};

type SessionPayload = AuthUser & {
  access_version: string;
  iat: number;
  exp: number;
  version: 1;
};

type AccessEntry = AuthUser & {
  code: string;
};

type JsonObject = Record<string, unknown>;

class UpstreamError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const incoming = new URL(request.url);
    const action = incoming.searchParams.get("action") || "health";
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      if (origin !== ALLOWED_ORIGIN) {
        return apiError("ORIGINE_REFUSEE", "Origine non autorisée.", 403, origin);
      }
      return new Response(null, { status: 204, headers: responseHeaders(origin) });
    }

    if (action !== "health" && origin !== ALLOWED_ORIGIN) {
      return apiError("ORIGINE_REFUSEE", "Origine non autorisée.", 403, origin);
    }

    try {
      requireSecrets(env);

      if (action === "health") {
        if (request.method !== "GET") {
          return apiError("METHODE_REFUSEE", "Méthode non autorisée.", 405, origin);
        }
        return apiJson(
          { ok: true, service: "suivi-agents", time: new Date().toISOString() },
          200,
          origin,
        );
      }

      if (action === "login") {
        if (request.method !== "POST") {
          return apiError("METHODE_REFUSEE", "Méthode non autorisée.", 405, origin);
        }
        return await login(request, env, origin);
      }

      if (action === "logout") {
        if (request.method !== "POST") {
          return apiError("METHODE_REFUSEE", "Méthode non autorisée.", 405, origin);
        }
        return apiJson(
          { ok: true },
          200,
          origin,
          { "Set-Cookie": clearSessionCookie() },
        );
      }

      const session = await sessionFromRequest(request, env.SESSION_SECRET);
      if (!session) {
        return apiError(
          "AUTH_REQUISE",
          "Votre session a expiré. Reconnectez-vous.",
          401,
          origin,
          { "Set-Cookie": clearSessionCookie() },
        );
      }
      const principal = await authorizedPrincipal(session, env);

      if (action === "session") {
        if (request.method !== "GET") {
          return apiError("METHODE_REFUSEE", "Méthode non autorisée.", 405, origin);
        }
        return apiJson({ ok: true, user: principal }, 200, origin);
      }

      if (request.method === "GET") {
        if (!GET_ACTIONS.has(action)) {
          return apiError("ACTION_REFUSEE", "Action non autorisée.", 403, origin);
        }
        const params: Record<string, string> = {
          auth_user_id: principal.id,
          auth_session_version: session.access_version,
        };
        const id = incoming.searchParams.get("id");
        if (id) params.id = id;
        const result = await callAppsScript(env, "GET", action, {}, params);
        return apiJson(result, 200, origin);
      }

      if (request.method === "POST") {
        if (!POST_ACTIONS.has(action)) {
          return apiError("ACTION_REFUSEE", "Action non autorisée.", 403, origin);
        }
        const payload = await readJsonBody(request, MAX_BODY_BYTES);
        payload.auth_user_id = principal.id;
        payload.auth_session_version = session.access_version;
        if (action === "saveFirstDay") payload.chef_nom = principal.display_name;
        if (action === "saveEvaluationDraft" || action === "finalizeEvaluation") {
          payload.evaluateur = principal.display_name;
        }
        let result: JsonObject;
        try {
          result = await callAppsScript(env, "POST", action, payload, {});
        } catch (error) {
          if (action !== "submitSituation" || !(error instanceof UpstreamError) || error.code !== "ACTION_INCONNUE") {
            throw error;
          }
          result = await submitSituationToLegacyForm(env, payload, principal, session.access_version);
        }
        return apiJson(result, 200, origin);
      }

      return apiError("METHODE_REFUSEE", "Méthode non autorisée.", 405, origin);
    } catch (error) {
      if (error instanceof UpstreamError) {
        const status = statusForCode(error.code);
        const message = status === 401
          ? "Code incorrect ou accès non autorisé."
          : publicMessage(error.code, error.message);
        const extra: HeadersInit = status === 401
          ? { "Set-Cookie": clearSessionCookie() }
          : {};
        return apiError(error.code, message, status, origin, extra);
      }

      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ event: "worker_error", action, message }));
      return apiError(
        "ERREUR_INTERNE",
        "Le service est temporairement indisponible.",
        500,
        origin,
      );
    }
  },
} satisfies ExportedHandler<Env>;

async function login(request: Request, env: Env, origin: string): Promise<Response> {
  const limiterKey = await loginLimiterKey(request);
  const [ipLimit, globalLimit] = await Promise.all([
    env.LOGIN_IP_LIMITER.limit({ key: limiterKey }),
    env.LOGIN_GLOBAL_LIMITER.limit({ key: "all-logins" }),
  ]);
  if (!ipLimit.success || !globalLimit.success) {
    return apiError(
      "TROP_DE_TENTATIVES",
      "Trop de tentatives. Attendez une minute avant de réessayer.",
      429,
      origin,
      { "Retry-After": "60" },
    );
  }

  const payload = await readJsonBody(request, MAX_LOGIN_BODY_BYTES);
  const code = String(payload.code || "").trim();
  if (!/^\d{6}$/.test(code)) {
    return apiError(
      "CODE_INVALIDE",
      "Le code doit contenir exactement 6 chiffres.",
      401,
      origin,
    );
  }

  const matches = (await Promise.all(
    accessDirectory(env).map(async entry => await secretEquals(entry.code, code) ? entry : null),
  )).filter((entry): entry is AccessEntry => entry !== null);
  if (matches.length !== 1) {
    throw new UpstreamError("AUTH_INVALIDE", "Code incorrect ou accès non autorisé.");
  }
  const matched = matches[0];
  const user = publicAccessUser(matched);
  const accessVersion = await accessVersionFor(matched, env.APPS_SCRIPT_KEY);
  const token = await createSessionToken(
    { ...user, access_version: accessVersion },
    env.SESSION_SECRET,
  );
  return apiJson(
    { ok: true, user },
    200,
    origin,
    { "Set-Cookie": sessionCookie(token) },
  );
}

function requireSecrets(env: Env): void {
  if (!env.APPS_SCRIPT_URL) throw new Error("APPS_SCRIPT_URL_MANQUANTE");
  if (!env.APPS_SCRIPT_KEY) throw new Error("APPS_SCRIPT_KEY_MANQUANTE");
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
    throw new Error("SESSION_SECRET_MANQUANT");
  }
  if (!env.ACCESS_DIRECTORY_JSON) throw new Error("ACCESS_DIRECTORY_JSON_MANQUANT");
}

function accessDirectory(env: Env): AccessEntry[] {
  let source: unknown;
  try {
    source = JSON.parse(env.ACCESS_DIRECTORY_JSON);
  } catch {
    throw new Error("ACCESS_DIRECTORY_JSON_INVALIDE");
  }
  if (!Array.isArray(source) || source.length < 1 || source.length > 20) {
    throw new Error("ACCESS_DIRECTORY_JSON_INVALIDE");
  }
  const entries = source.map(value => {
    if (!value || Array.isArray(value) || typeof value !== "object") {
      throw new Error("ACCESS_DIRECTORY_JSON_INVALIDE");
    }
    const object = value as Record<string, unknown>;
    const user = validateAuthUser(object);
    const code = String(object.code || "").trim();
    if (!/^\d{6}$/.test(code)) throw new Error("ACCESS_DIRECTORY_JSON_INVALIDE");
    return { ...user, code };
  });
  if (new Set(entries.map(entry => entry.id)).size !== entries.length ||
      new Set(entries.map(entry => entry.code)).size !== entries.length) {
    throw new Error("ACCESS_DIRECTORY_JSON_INVALIDE");
  }
  return entries;
}

function publicAccessUser(entry: AccessEntry): AuthUser {
  return {
    id: entry.id,
    nom: entry.nom,
    prenom: entry.prenom,
    poste: entry.poste,
    display_name: entry.display_name,
    is_admin: entry.is_admin,
  };
}

async function authorizedPrincipal(session: SessionPayload, env: Env): Promise<AuthUser> {
  const matches = accessDirectory(env).filter(entry => entry.id === session.id);
  if (matches.length !== 1) throw new UpstreamError("AUTH_REQUISE", "Session révoquée.");
  const expected = await accessVersionFor(matches[0], env.APPS_SCRIPT_KEY);
  if (!await secretEquals(expected, session.access_version)) {
    throw new UpstreamError("AUTH_REQUISE", "Session révoquée.");
  }
  return publicAccessUser(matches[0]);
}

async function accessVersionFor(entry: AccessEntry, secret: string): Promise<string> {
  return base64UrlEncode(await sign(`${entry.id}|${entry.code}`, secret));
}

async function secretEquals(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(right)),
  ]);
  const leftBytes = new Uint8Array(a);
  const rightBytes = new Uint8Array(b);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < Math.max(leftBytes.length, rightBytes.length); index++) {
    difference |= leftBytes[index % leftBytes.length] ^ rightBytes[index % rightBytes.length];
  }
  return difference === 0;
}

async function submitSituationToLegacyForm(
  env: Env,
  payload: JsonObject,
  principal: AuthUser,
  accessVersion: string,
): Promise<JsonObject> {
  const id = String(payload.id_agent || "").trim();
  if (!id) throw new UpstreamError("ID_AGENT_MANQUANT", "Agent manquant.");
  const impact = String(payload.impact || "").trim();
  if (!["🟢 Bénéfique", "⚪ Neutre", "🔴 Problématique"].includes(impact)) {
    throw new UpstreamError("IMPACT_INVALIDE", "Impact invalide.");
  }
  const contexte = boundedText(payload.contexte, 2_000, "CONTEXTE_TROP_LONG");
  const consequence = boundedText(payload.consequence, 2_000, "CONSEQUENCE_TROP_LONGUE");
  const fait = boundedText(payload.fait, 4_000, "FAIT_TROP_LONG");
  if (!fait) throw new UpstreamError("FAIT_REQUIS", "Le fait est obligatoire.");

  const agentResult = await callAppsScript(env, "GET", "getAgent", {}, {
    id,
    auth_user_id: principal.id,
    auth_session_version: accessVersion,
  });
  const agent = agentResult.agent;
  if (!agent || Array.isArray(agent) || typeof agent !== "object") {
    throw new UpstreamError("AGENT_INTROUVABLE", "Agent introuvable.");
  }
  const source = agent as Record<string, unknown>;
  const agentName = `${String(source.prenom || "").trim()} ${String(source.nom || "").trim()}`.trim();
  if (!agentName) throw new UpstreamError("AGENT_INTROUVABLE", "Agent introuvable.");

  const form = new URLSearchParams({
    "entry.890293520": agentName,
    "entry.1536926610": impact,
    "entry.922365674": contexte,
    "entry.1133964165": consequence,
    "entry.2080031732": fait,
    "entry.2073189400": principal.display_name,
  });
  const response = await fetch(LEGACY_SITUATION_FORM_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: form,
    redirect: "follow",
  });
  if (!response.ok) {
    throw new UpstreamError("ENREGISTREMENT_SITUATION_ECHOUE", "Enregistrement impossible.");
  }
  return { ok: true, verified: true, responsable: principal.display_name };
}

function boundedText(value: unknown, maxLength: number, errorCode: string): string {
  const text = String(value || "").trim();
  if (text.length > maxLength) throw new UpstreamError(errorCode, "Texte trop long.");
  return text;
}

async function callAppsScript(
  env: Env,
  method: "GET" | "POST",
  action: string,
  payload: JsonObject,
  params: Record<string, string>,
): Promise<JsonObject> {
  let response: Response;
  if (method === "GET") {
    const googleUrl = new URL(env.APPS_SCRIPT_URL);
    googleUrl.searchParams.set("key", env.APPS_SCRIPT_KEY);
    googleUrl.searchParams.set("action", action);
    for (const [key, value] of Object.entries(params)) {
      if (value) googleUrl.searchParams.set(key, value);
    }
    response = await fetch(googleUrl.toString(), { method: "GET", redirect: "follow" });
  } else {
    const body = new URLSearchParams();
    body.set(
      "payload",
      JSON.stringify({ ...payload, action, key: env.APPS_SCRIPT_KEY }),
    );
    response = await fetch(env.APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body,
      redirect: "follow",
    });
  }

  const raw = await response.text();
  const data = parseAppsScriptResponse(raw);
  if (!data) {
    throw new UpstreamError(
      "REPONSE_GOOGLE_INVALIDE",
      "Le service de données n’a pas renvoyé une réponse exploitable.",
    );
  }
  if (data.ok === false) {
    throw new UpstreamError(
      String(data.code || "ERREUR_GOOGLE"),
      String(data.message || data.code || "Erreur du service de données."),
    );
  }
  return data;
}

function parseAppsScriptResponse(raw: string): JsonObject | null {
  try {
    return JSON.parse(raw) as JsonObject;
  } catch {
    return null;
  }
}

async function readJsonBody(request: Request, maxBytes: number): Promise<JsonObject> {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > maxBytes) {
    throw new UpstreamError("CORPS_TROP_VOLUMINEUX", "Données trop volumineuses.");
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) {
    throw new UpstreamError("CORPS_TROP_VOLUMINEUX", "Données trop volumineuses.");
  }
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("invalid shape");
    }
    return parsed as JsonObject;
  } catch {
    throw new UpstreamError("JSON_INVALIDE", "Le site a envoyé des données invalides.");
  }
}

function validateAuthUser(value: unknown): AuthUser {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new UpstreamError("AUTH_INVALIDE", "Identité invalide.");
  }
  const source = value as Record<string, unknown>;
  const user: AuthUser = {
    id: String(source.id || ""),
    nom: String(source.nom || ""),
    prenom: String(source.prenom || ""),
    poste: String(source.poste || ""),
    display_name: String(source.display_name || ""),
    is_admin: source.is_admin === true,
  };
  if (!user.id || !user.nom || !user.prenom || !user.display_name) {
    throw new UpstreamError("AUTH_INVALIDE", "Identité incomplète.");
  }
  return user;
}

export async function createSessionToken(
  user: AuthUser & { access_version: string },
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const payload: SessionPayload = {
    ...user,
    iat: nowSeconds,
    exp: nowSeconds + SESSION_TTL_SECONDS,
    version: 1,
  };
  const encodedPayload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await sign(encodedPayload, secret);
  return `${encodedPayload}.${base64UrlEncode(signature)}`;
}

export async function readSessionToken(
  token: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<SessionPayload | null> {
  const [encodedPayload, encodedSignature, extra] = token.split(".");
  if (!encodedPayload || !encodedSignature || extra) return null;
  let signature: Uint8Array;
  try {
    signature = base64UrlDecode(encodedSignature);
  } catch {
    return null;
  }
  const key = await hmacKey(secret, ["verify"]);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    Uint8Array.from(signature).buffer,
    new TextEncoder().encode(encodedPayload),
  );
  if (!valid) return null;

  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedPayload)));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return null;
    const payload = parsed as Partial<SessionPayload>;
    if (
      payload.version !== 1 ||
      typeof payload.exp !== "number" ||
      typeof payload.iat !== "number" ||
      typeof payload.id !== "string" ||
      typeof payload.display_name !== "string" ||
      typeof payload.nom !== "string" ||
      typeof payload.prenom !== "string" ||
      typeof payload.poste !== "string" ||
      typeof payload.is_admin !== "boolean" ||
      typeof payload.access_version !== "string" ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(payload.access_version) ||
      payload.exp <= nowSeconds ||
      payload.iat > nowSeconds + 60 ||
      payload.exp - payload.iat !== SESSION_TTL_SECONDS
    ) {
      return null;
    }
    return payload as SessionPayload;
  } catch {
    return null;
  }
}

async function sessionFromRequest(request: Request, secret: string): Promise<SessionPayload | null> {
  const token = readCookie(request.headers.get("Cookie") || "", SESSION_COOKIE);
  if (!token) return null;
  return await readSessionToken(token, secret);
}

async function sign(value: string, secret: string): Promise<Uint8Array> {
  const key = await hmacKey(secret, ["sign"]);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );
  return new Uint8Array(signature);
}

async function hmacKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

async function loginLimiterKey(request: Request): Promise<string> {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  return base64UrlEncode(new Uint8Array(digest));
}

function readCookie(header: string, name: string): string {
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}

function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function statusForCode(code: string): number {
  if (/ORIGINE|ACTION_REFUSEE/.test(code)) return 403;
  if (/AUTH|CODE_INVALIDE/.test(code)) return 401;
  if (/INTROUVABLE|MANQUANT$/.test(code)) return 404;
  if (/IMMUABLE|EXISTANT|INCOHERENT|DUPLIQUE/.test(code)) return 409;
  if (/TROP_VOLUMINEUX/.test(code)) return 413;
  if (/CONFIG|ACCES_REFUSE|SERVICE_AVANCE|CONVERSION|GENERATION|VERIFICATION|REPONSE_GOOGLE/.test(code)) return 502;
  return 400;
}

function publicMessage(code: string, fallback: string): string {
  if (/CONFIG|ACCES_REFUSE|SERVICE_AVANCE|CONVERSION|GENERATION|VERIFICATION|REPONSE_GOOGLE/.test(code)) {
    return "Le service est temporairement indisponible.";
  }
  if (/ACCES|AUTH|CODE/.test(code)) return "Code incorrect ou accès non autorisé.";
  return fallback || "La demande n’a pas pu être traitée.";
}

function responseHeaders(origin: string, extra: HeadersInit = {}): Headers {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-site",
    Vary: "Origin",
  });
  if (origin === ALLOWED_ORIGIN) {
    headers.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
    headers.set("Access-Control-Max-Age", "86400");
  }
  const additions = new Headers(extra);
  additions.forEach((value, key) => headers.set(key, value));
  return headers;
}

function apiJson(
  data: unknown,
  status: number,
  origin: string,
  extra: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: responseHeaders(origin, extra),
  });
}

function apiError(
  code: string,
  message: string,
  status: number,
  origin: string,
  extra: HeadersInit = {},
): Response {
  return apiJson({ ok: false, code, message }, status, origin, extra);
}
