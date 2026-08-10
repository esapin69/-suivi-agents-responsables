const SITE_ORIGIN = "https://responsable.esapin.com";
const SESSION_COOKIE = "__Host-ghe_session";
const SESSION_TTL = 8 * 60 * 60;
const MAX_BODY_BYTES = 250_000;

type Env = {
  APPS_SCRIPT_URL: string;
  APPS_SCRIPT_KEY: string;
  SESSION_SECRET: string;
  LOGIN_IP_LIMITER?: { limit(input: { key: string }): Promise<{ success: boolean }> };
  LOGIN_GLOBAL_LIMITER?: { limit(input: { key: string }): Promise<{ success: boolean }> };
};

type User = {
  id_responsable: string;
  nom: string;
  prenom: string;
  poste: string;
  display_name: string;
  is_admin: boolean;
};

type Session = User & {
  access_version: string;
  iat: number;
  exp: number;
  v: 1;
};

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

class ApiError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      if (origin !== SITE_ORIGIN) return jsonError("ORIGINE_REFUSEE", "Origine non autorisée.", 403, origin);
      return new Response(null, { status: 204, headers: headers(origin) });
    }

    if (origin && origin !== SITE_ORIGIN) {
      return jsonError("ORIGINE_REFUSEE", "Origine non autorisée.", 403, origin);
    }

    try {
      requireEnv(env);

      if (url.pathname === "/health") {
        return json({ ok: true, service: "responsables-api" }, 200, origin);
      }

      if (url.pathname === "/auth/login") return handleLogin(request, env, origin);
      if (url.pathname === "/auth/logout") return handleLogout(request, origin);
      if (url.pathname === "/auth/me") return handleMe(request, env, origin);

      const session = await requireSession(request, env.SESSION_SECRET);
      const action = url.searchParams.get("action") || "";

      if (request.method === "GET") {
        if (!GET_ACTIONS.has(action)) throw new ApiError("ACTION_REFUSEE", "Action non autorisée.", 403);
        const params: Record<string, string> = authParams(session);
        const id = url.searchParams.get("id");
        if (id) params.id = id;
        const result = await callAppsScript(env, "GET", action, {}, params);
        return json(result, 200, origin);
      }

      if (request.method === "POST") {
        if (!POST_ACTIONS.has(action)) throw new ApiError("ACTION_REFUSEE", "Action non autorisée.", 403);
        const payload = await readJson(request);

        // L'identité ne vient jamais du navigateur : le serveur l'impose.
        payload.id_responsable = session.id_responsable;
        payload.evaluateur = session.display_name;
        payload.responsable = session.display_name;
        payload.auth_user_id = session.id_responsable;
        payload.auth_session_version = session.access_version;

        const result = await callAppsScript(env, "POST", action, payload, {});
        return json(result, 200, origin);
      }

      throw new ApiError("METHODE_REFUSEE", "Méthode non autorisée.", 405);
    } catch (error) {
      if (error instanceof ApiError) {
        const extra = error.status === 401 ? { "Set-Cookie": clearCookie() } : {};
        return jsonError(error.code, publicMessage(error), error.status, origin, extra);
      }
      console.error("worker_error", error);
      return jsonError("ERREUR_INTERNE", "Le service est temporairement indisponible.", 500, origin);
    }
  },
};

async function handleLogin(request: Request, env: Env, origin: string): Promise<Response> {
  if (request.method !== "POST") throw new ApiError("METHODE_REFUSEE", "Méthode non autorisée.", 405);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (env.LOGIN_IP_LIMITER) {
    const r = await env.LOGIN_IP_LIMITER.limit({ key: await sha256(ip) });
    if (!r.success) throw new ApiError("TROP_DE_TENTATIVES", "Trop de tentatives. Réessayez dans une minute.", 429);
  }
  if (env.LOGIN_GLOBAL_LIMITER) {
    const r = await env.LOGIN_GLOBAL_LIMITER.limit({ key: "responsables-login" });
    if (!r.success) throw new ApiError("TROP_DE_TENTATIVES", "Trop de tentatives. Réessayez dans une minute.", 429);
  }

  const body = await readJson(request, 2_000);
  const code = String(body.code || "").trim();
  if (!/^\d{6}$/.test(code)) throw new ApiError("CODE_INVALIDE", "Le code doit contenir exactement 6 chiffres.", 401);

  const result = await callAppsScript(env, "POST", "authenticateAccess", { code }, {});
  const user = normalizeUser(result.user);
  const accessVersion = String(result.session_version || "");
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(accessVersion)) {
    throw new ApiError("AUTH_INVALIDE", "Accès invalide.", 401);
  }

  const token = await createToken(user, accessVersion, env.SESSION_SECRET);
  return json({ ok: true, user }, 200, origin, { "Set-Cookie": sessionCookie(token) });
}

async function handleMe(request: Request, env: Env, origin: string): Promise<Response> {
  if (request.method !== "GET") throw new ApiError("METHODE_REFUSEE", "Méthode non autorisée.", 405);
  const session = await requireSession(request, env.SESSION_SECRET);

  // Vérifie aussi que le responsable est toujours autorisé dans la feuille.
  const result = await callAppsScript(env, "GET", "authorizeAccess", {}, authParams(session));
  const user = normalizeUser(result.user || session);
  return json({ ok: true, user }, 200, origin);
}

function handleLogout(request: Request, origin: string): Response {
  if (request.method !== "POST") throw new ApiError("METHODE_REFUSEE", "Méthode non autorisée.", 405);
  return json({ ok: true }, 200, origin, { "Set-Cookie": clearCookie() });
}

function authParams(session: Session): Record<string, string> {
  return {
    auth_user_id: session.id_responsable,
    auth_session_version: session.access_version,
  };
}

async function callAppsScript(
  env: Env,
  method: "GET" | "POST",
  action: string,
  payload: Record<string, any>,
  params: Record<string, string>,
): Promise<any> {
  let response: Response;

  if (method === "GET") {
    const url = new URL(env.APPS_SCRIPT_URL);
    url.searchParams.set("key", env.APPS_SCRIPT_KEY);
    url.searchParams.set("action", action);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    response = await fetch(url.toString(), { redirect: "follow" });
  } else {
    const form = new URLSearchParams();
    form.set("payload", JSON.stringify({ ...payload, action, key: env.APPS_SCRIPT_KEY }));
    response = await fetch(env.APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: form,
      redirect: "follow",
    });
  }

  const text = await response.text();
  let data: any;
  try { data = JSON.parse(text); }
  catch { throw new ApiError("REPONSE_GOOGLE_INVALIDE", "Réponse Google invalide.", 502); }

  if (!data || data.ok === false) {
    const code = String(data?.code || "ERREUR_GOOGLE");
    const status = /AUTH|ACCES|CODE/.test(code) ? 401 : 400;
    throw new ApiError(code, String(data?.message || "Erreur du service de données."), status);
  }
  return data;
}

function normalizeUser(value: any): User {
  const id = String(value?.id_responsable || value?.id || "");
  const nom = String(value?.nom || "").trim();
  const prenom = String(value?.prenom || "").trim();
  if (!id || !nom || !prenom) throw new ApiError("AUTH_INVALIDE", "Identité incomplète.", 401);
  return {
    id_responsable: id,
    nom,
    prenom,
    poste: String(value?.poste || ""),
    display_name: String(value?.display_name || `${prenom} ${nom}`).trim(),
    is_admin: value?.is_admin === true,
  };
}

async function createToken(user: User, accessVersion: string, secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const session: Session = { ...user, access_version: accessVersion, iat: now, exp: now + SESSION_TTL, v: 1 };
  const payload = b64url(new TextEncoder().encode(JSON.stringify(session)));
  const signature = await hmac(payload, secret, "sign");
  return `${payload}.${b64url(new Uint8Array(signature as ArrayBuffer))}`;
}

async function requireSession(request: Request, secret: string): Promise<Session> {
  const token = cookie(request.headers.get("Cookie") || "", SESSION_COOKIE);
  if (!token) throw new ApiError("AUTH_REQUISE", "Connexion requise.", 401);

  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) throw new ApiError("AUTH_REQUISE", "Session invalide.", 401);

  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
  );
  const valid = await crypto.subtle.verify("HMAC", key, fromB64url(signature), new TextEncoder().encode(payload));
  if (!valid) throw new ApiError("AUTH_REQUISE", "Session invalide.", 401);

  let session: Session;
  try { session = JSON.parse(new TextDecoder().decode(fromB64url(payload))); }
  catch { throw new ApiError("AUTH_REQUISE", "Session invalide.", 401); }

  const now = Math.floor(Date.now() / 1000);
  if (session.v !== 1 || !session.id_responsable || !session.access_version || session.exp <= now) {
    throw new ApiError("AUTH_REQUISE", "Votre session a expiré.", 401);
  }
  return session;
}

async function readJson(request: Request, maxBytes = MAX_BODY_BYTES): Promise<Record<string, any>> {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) throw new ApiError("CORPS_TROP_VOLUMINEUX", "Données trop volumineuses.", 413);
  try {
    const value = JSON.parse(raw || "{}");
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error();
    return value;
  } catch {
    throw new ApiError("JSON_INVALIDE", "Données invalides.", 400);
  }
}

function requireEnv(env: Env) {
  if (!env.APPS_SCRIPT_URL) throw new Error("APPS_SCRIPT_URL manquant");
  if (!env.APPS_SCRIPT_KEY) throw new Error("APPS_SCRIPT_KEY manquant");
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new Error("SESSION_SECRET manquant");
}

function sessionCookie(token: string) {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_TTL}; HttpOnly; Secure; SameSite=Strict`;
}
function clearCookie() {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}
function cookie(header: string, name: string) {
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}

function headers(origin: string, extra: Record<string, string> = {}) {
  const h = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Vary": "Origin",
  });
  if (origin === SITE_ORIGIN) {
    h.set("Access-Control-Allow-Origin", SITE_ORIGIN);
    h.set("Access-Control-Allow-Credentials", "true");
    h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    h.set("Access-Control-Allow-Headers", "Content-Type");
  }
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return h;
}
function json(data: any, status: number, origin: string, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers: headers(origin, extra) });
}
function jsonError(code: string, message: string, status: number, origin: string, extra: Record<string, string> = {}) {
  return json({ ok: false, code, message }, status, origin, extra);
}
function publicMessage(error: ApiError) {
  if (error.status >= 500) return "Le service est temporairement indisponible.";
  if (error.status === 401) return error.code === "TROP_DE_TENTATIVES" ? error.message : "Code incorrect ou accès non autorisé.";
  return error.message;
}

async function hmac(value: string, secret: string, usage: "sign") {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]
  );
  return crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
}
async function sha256(value: string) {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}
function b64url(bytes: Uint8Array) {
  let s = ""; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function fromB64url(value: string) {
  const s = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}
