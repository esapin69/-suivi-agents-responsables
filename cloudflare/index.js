const ALLOWED_ORIGINS = new Set([
  "https://responsable.esapin.com",
  "https://planning.esapin.com",
  "https://nouvel-agent.esapin.com"
]);
const SESSION_COOKIE = "__Host-ghe_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const APPS_SCRIPT_TIMEOUT_MS = 8000;
const ACTION_TIMEOUTS_MS = Object.freeze({
  authenticateAccess: 15000,
  createAgent: 30000,
  updateAgent: 20000,
  saveFirstDay: 20000,
  saveFollowup: 20000,
  saveEvaluationDraft: 20000,
  createAgentSignatureRequest: 20000,
  cancelAgentSignatureRequest: 15000,
  publicGetAgentSignature: 12000,
  publicSubmitAgentSignature: 25000,
  finalizeEvaluation: 60000,
  submitSituation: 20000
});
const AGENTS_CACHE_REFRESH_MS = 60 * 1000;
const AGENTS_CACHE_TTL_SECONDS = 5 * 60;
const AGENTS_CACHE_FETCH_TIMEOUT_MS = 12000;
const MAX_BODY_BYTES = 250000;
const MAX_PUBLIC_SIGNATURE_BODY_BYTES = 400000;
const MAX_PUBLIC_LOOKUP_BODY_BYTES = 5000;
const MAX_LOGIN_BODY_BYTES = 2000;

const GET_ACTIONS = new Set([
  "listAgents",
  "listDirectory",
  "getAgent",
  "getFirstDay",
  "getFollowup",
  "getFollowupOverview",
  "listEvaluations",
  "getEvaluation",
  "getAgentSignatureStatus"
]);

const POST_ACTIONS = new Set([
  "createAgent",
  "updateAgent",
  "saveFirstDay",
  "saveFollowup",
  "saveEvaluationDraft",
  "createAgentSignatureRequest",
  "cancelAgentSignatureRequest",
  "finalizeEvaluation",
  "submitSituation"
]);

const PUBLIC_POST_ACTIONS = new Set([
  "publicGetAgentSignature",
  "publicSubmitAgentSignature"
]);

class UpstreamError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export default {
  async fetch(request, env, ctx) {
    const incoming = new URL(request.url);
    const action = incoming.searchParams.get("action") || "health";
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      if (!ALLOWED_ORIGINS.has(origin)) {
        return apiError("ORIGINE_REFUSEE", "Origine non autorisée.", 403, origin);
      }
      return new Response(null, { status: 204, headers: responseHeaders(origin) });
    }

    if (action !== "health" && !ALLOWED_ORIGINS.has(origin)) {
      return apiError("ORIGINE_REFUSEE", "Origine non autorisée.", 403, origin);
    }

    try {
      requireSecrets(env);

      if (action === "health") {
        if (request.method !== "GET") {
          return apiError("METHODE_REFUSEE", "Méthode non autorisée.", 405, origin);
        }
        return apiJson({
          ok: true,
          service: "suivi-agents",
          bridge: "cloudflare",
          time: new Date().toISOString()
        }, 200, origin);
      }

      if (action === "login") {
        if (request.method !== "POST") {
          return apiError("METHODE_REFUSEE", "Méthode non autorisée.", 405, origin);
        }
        return await login(request, env, origin, ctx);
      }

      if (action === "logout") {
        if (request.method !== "POST") {
          return apiError("METHODE_REFUSEE", "Méthode non autorisée.", 405, origin);
        }
        return apiJson({ ok: true }, 200, origin, {
          "Set-Cookie": clearSessionCookie()
        });
      }

      if (PUBLIC_POST_ACTIONS.has(action)) {
        if (request.method !== "POST") {
          return apiError("METHODE_REFUSEE", "Méthode non autorisée.", 405, origin);
        }
        const maxBytes = action === "publicSubmitAgentSignature"
          ? MAX_PUBLIC_SIGNATURE_BODY_BYTES
          : MAX_PUBLIC_LOOKUP_BODY_BYTES;
        const payload = await readJsonBody(request, maxBytes);
        const result = await callAppsScript(
          env,
          "POST",
          action,
          payload,
          {},
          timeoutForAction(action)
        );
        return apiJson(result, 200, origin);
      }

      const session = await sessionFromRequest(request, env.SESSION_SECRET);
      if (!session) {
        return apiError(
          "AUTH_REQUISE",
          "Votre session a expiré. Reconnectez-vous.",
          401,
          origin,
          { "Set-Cookie": clearSessionCookie() }
        );
      }

      if (action === "session") {
        if (request.method !== "GET") {
          return apiError("METHODE_REFUSEE", "Méthode non autorisée.", 405, origin);
        }
        return apiJson({ ok: true, user: publicSessionUser(session) }, 200, origin);
      }

      if (request.method === "GET") {
        if (!GET_ACTIONS.has(action)) {
          return apiError("ACTION_REFUSEE", "Action non autorisée.", 403, origin);
        }

        if (action === "listAgents") {
          if (!session.access || session.access.suivi_des_agents !== true) {
            return apiError(
              "ACCES_REFUSE",
              "Cette rubrique n’est pas autorisée pour votre profil.",
              403,
              origin
            );
          }
          return await listAgentsCached(env, session, origin, ctx);
        }

        const params = {
          auth_user_id: session.id,
          auth_session_version: session.access_version
        };

        const id = incoming.searchParams.get("id");
        if (id) params.id = id;
        const step = incoming.searchParams.get("step");
        if (step) params.step = step;

        const result = await callAppsScript(env, "GET", action, {}, params);
        return apiJson(result, 200, origin);
      }

      if (request.method === "POST") {
        if (!POST_ACTIONS.has(action)) {
          return apiError("ACTION_REFUSEE", "Action non autorisée.", 403, origin);
        }

        const payload = await readJsonBody(request, MAX_BODY_BYTES);
        payload.auth_user_id = session.id;
        payload.auth_session_version = session.access_version;

        if (action === "saveFirstDay") payload.chef_nom = session.display_name;
        if (action === "saveEvaluationDraft" || action === "finalizeEvaluation") {
          payload.evaluateur = session.display_name;
        }

        const result = await callAppsScript(
          env,
          "POST",
          action,
          payload,
          {},
          timeoutForAction(action)
        );

        if (action === "createAgent" || action === "updateAgent") {
          ctx.waitUntil(invalidateAgentsCache().catch(error => {
            console.error(JSON.stringify({ event: "agents_cache_invalidate_error", message: String(error) }));
          }));
        }

        return apiJson(result, 200, origin);
      }

      return apiError("METHODE_REFUSEE", "Méthode non autorisée.", 405, origin);
    } catch (error) {
      if (error instanceof UpstreamError) {
        const status = statusForCode(error.code);
        const message =
          status === 401
            ? "Code incorrect ou accès non autorisé."
            : publicMessage(error.code, error.message);

        const extra = status === 401
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
        origin
      );
    }
  }
};

async function login(request, env, origin, ctx) {
  const limiterKey = await loginLimiterKey(request);

  const [ipLimit, globalLimit] = await Promise.all([
    env.LOGIN_IP_LIMITER.limit({ key: limiterKey }),
    env.LOGIN_GLOBAL_LIMITER.limit({ key: "all-logins" })
  ]);

  if (!ipLimit.success || !globalLimit.success) {
    return apiError(
      "TROP_DE_TENTATIVES",
      "Trop de tentatives. Attendez une minute avant de réessayer.",
      429,
      origin,
      { "Retry-After": "60" }
    );
  }

  const payload = await readJsonBody(request, MAX_LOGIN_BODY_BYTES);
  const code = String(payload.code || "").trim();

  if (!/^\d{6}$/.test(code)) {
    return apiError(
      "CODE_INVALIDE",
      "Le code doit contenir exactement 6 chiffres.",
      401,
      origin
    );
  }

  const result = await callAppsScript(
    env,
    "POST",
    "authenticateAccess",
    { code },
    {},
    timeoutForAction("authenticateAccess")
  );

  const user = validateAuthUser(result.user);
  const accessVersion = String(result.session_version || "");

  if (!/^[A-Za-z0-9_-]{32,128}$/.test(accessVersion)) {
    throw new UpstreamError("AUTH_INVALIDE", "Version d’accès invalide.");
  }

  const token = await createSessionToken(
    {
      id: user.id,
      nom: user.nom,
      prenom: user.prenom,
      poste: user.poste,
      display_name: user.display_name,
      is_admin: user.is_admin,
      access: user.access,
      access_version: accessVersion
    },
    env.SESSION_SECRET
  );

  if (user.access && user.access.suivi_des_agents === true) {
    const warmSession = {
      id: user.id,
      access_version: accessVersion
    };
    ctx.waitUntil(refreshAgentsCache(env, warmSession).catch(error => {
      console.error(JSON.stringify({ event: "agents_cache_warm_error", message: String(error) }));
    }));
  }

  return apiJson(
    { ok: true, user },
    200,
    origin,
    { "Set-Cookie": sessionCookie(token) }
  );
}

function timeoutForAction(action) {
  return Number(ACTION_TIMEOUTS_MS[action] || APPS_SCRIPT_TIMEOUT_MS);
}

async function listAgentsCached(env, session, origin, ctx) {
  const cache = caches.default;
  const key = agentsCacheKey();
  const cached = await cache.match(key);

  if (cached) {
    const data = await cached.json();
    const cachedAt = Number(cached.headers.get("X-GHE-Cached-At") || 0);

    if (!cachedAt || Date.now() - cachedAt >= AGENTS_CACHE_REFRESH_MS) {
      ctx.waitUntil(refreshAgentsCache(env, session).catch(error => {
        console.error(JSON.stringify({ event: "agents_cache_refresh_error", message: String(error) }));
      }));
    }

    return apiJson(data, 200, origin, { "X-GHE-Cache": "HIT" });
  }

  const data = await fetchAgentsFromAppsScript(env, session);
  await putAgentsCache(data);
  return apiJson(data, 200, origin, { "X-GHE-Cache": "MISS" });
}

async function fetchAgentsFromAppsScript(env, session) {
  return await callAppsScript(
    env,
    "GET",
    "listAgents",
    {},
    {
      auth_user_id: session.id,
      auth_session_version: session.access_version
    },
    AGENTS_CACHE_FETCH_TIMEOUT_MS
  );
}

async function refreshAgentsCache(env, session) {
  const data = await fetchAgentsFromAppsScript(env, session);
  await putAgentsCache(data);
  return data;
}

async function putAgentsCache(data) {
  const response = new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${AGENTS_CACHE_TTL_SECONDS}`,
      "X-GHE-Cached-At": String(Date.now())
    }
  });
  await caches.default.put(agentsCacheKey(), response);
}

async function invalidateAgentsCache() {
  await caches.default.delete(agentsCacheKey());
}

function agentsCacheKey() {
  return new Request("https://responsable-api.esapin.com/__internal_cache/listAgents", {
    method: "GET"
  });
}

function requireSecrets(env) {
  if (!env.APPS_SCRIPT_URL) throw new Error("APPS_SCRIPT_URL_MANQUANTE");
  if (!env.APPS_SCRIPT_KEY) throw new Error("APPS_SCRIPT_KEY_MANQUANTE");

  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
    throw new Error("SESSION_SECRET_MANQUANT");
  }

  if (!env.LOGIN_IP_LIMITER || !env.LOGIN_GLOBAL_LIMITER) {
    throw new Error("CONFIG_RATE_LIMIT_MANQUANTE");
  }
}

async function callAppsScript(env, method, action, payload, params, timeoutMs = APPS_SCRIPT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response;

    if (method === "GET") {
      const googleUrl = new URL(env.APPS_SCRIPT_URL);
      googleUrl.searchParams.set("key", env.APPS_SCRIPT_KEY);
      googleUrl.searchParams.set("action", action);

      for (const [key, value] of Object.entries(params)) {
        if (value) googleUrl.searchParams.set(key, value);
      }

      response = await fetch(googleUrl.toString(), {
        method: "GET",
        redirect: "follow",
        signal: controller.signal
      });
    } else {
      const body = new URLSearchParams();
      body.set(
        "payload",
        JSON.stringify({
          ...payload,
          action,
          key: env.APPS_SCRIPT_KEY
        })
      );

      response = await fetch(env.APPS_SCRIPT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
        },
        body,
        redirect: "follow",
        signal: controller.signal
      });
    }

    const raw = await response.text();
    const data = parseAppsScriptResponse(raw);

    if (!data) {
      throw new UpstreamError(
        "REPONSE_GOOGLE_INVALIDE",
        "Le service de données n’a pas renvoyé une réponse exploitable."
      );
    }

    if (data.ok === false) {
      throw new UpstreamError(
        String(data.code || "ERREUR_GOOGLE"),
        String(data.message || data.code || "Erreur du service de données.")
      );
    }

    return data;
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new UpstreamError(
        "TIMEOUT_GOOGLE",
        action === "finalizeEvaluation"
          ? "La génération du PDF a dépassé le délai prévu. Vérifiez le dossier officiel avant de relancer."
          : "Google Apps Script met trop de temps à répondre."
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseAppsScriptResponse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readJsonBody(request, maxBytes) {
  const declared = Number(request.headers.get("content-length") || 0);

  if (declared > maxBytes) {
    throw new UpstreamError("CORPS_TROP_VOLUMINEUX", "Données trop volumineuses.");
  }

  const raw = await request.text();

  if (new TextEncoder().encode(raw).byteLength > maxBytes) {
    throw new UpstreamError("CORPS_TROP_VOLUMINEUX", "Données trop volumineuses.");
  }

  try {
    const parsed = JSON.parse(raw || "{}");

    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("invalid shape");
    }

    return parsed;
  } catch {
    throw new UpstreamError(
      "JSON_INVALIDE",
      "Le site a envoyé des données invalides."
    );
  }
}

function validateAuthUser(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new UpstreamError("AUTH_INVALIDE", "Identité invalide.");
  }

  const source = value;

  const user = {
    id: String(source.id || ""),
    nom: String(source.nom || ""),
    prenom: String(source.prenom || ""),
    poste: String(source.poste || ""),
    display_name: String(source.display_name || ""),
    is_admin: source.is_admin === true,
    access: validateAccessMap(source.access)
  };

  if (!user.id || !user.nom || !user.prenom || !user.display_name) {
    throw new UpstreamError("AUTH_INVALIDE", "Identité incomplète.");
  }

  return user;
}

function validateAccessMap(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") return {};

  const access = {};

  for (const [key, allowed] of Object.entries(value)) {
    if (!/^[a-z0-9_]{1,80}$/.test(key)) continue;
    if (allowed === true) access[key] = true;
  }

  return access;
}

function publicSessionUser(session) {
  return {
    id: session.id,
    nom: session.nom,
    prenom: session.prenom,
    poste: session.poste,
    display_name: session.display_name,
    is_admin: session.is_admin === true,
    access: validateAccessMap(session.access)
  };
}

async function createSessionToken(
  user,
  secret,
  nowSeconds = Math.floor(Date.now() / 1000)
) {
  const payload = {
    id: String(user.id || ""),
    nom: String(user.nom || ""),
    prenom: String(user.prenom || ""),
    poste: String(user.poste || ""),
    display_name: String(user.display_name || ""),
    is_admin: user.is_admin === true,
    access: validateAccessMap(user.access),
    access_version: String(user.access_version || ""),
    iat: nowSeconds,
    exp: nowSeconds + SESSION_TTL_SECONDS,
    version: 1
  };

  const encodedPayload = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(payload))
  );

  const signature = await sign(encodedPayload, secret);

  return `${encodedPayload}.${base64UrlEncode(signature)}`;
}

async function readSessionToken(
  token,
  secret,
  nowSeconds = Math.floor(Date.now() / 1000)
) {
  const [encodedPayload, encodedSignature, extra] = token.split(".");

  if (!encodedPayload || !encodedSignature || extra) return null;

  let signature;

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
    new TextEncoder().encode(encodedPayload)
  );

  if (!valid) return null;

  try {
    const parsed = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(encodedPayload))
    );

    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      return null;
    }

    if (
      parsed.version !== 1 ||
      typeof parsed.exp !== "number" ||
      typeof parsed.iat !== "number" ||
      typeof parsed.id !== "string" ||
      typeof parsed.display_name !== "string" ||
      typeof parsed.nom !== "string" ||
      typeof parsed.prenom !== "string" ||
      typeof parsed.poste !== "string" ||
      typeof parsed.is_admin !== "boolean" ||
      typeof parsed.access_version !== "string" ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(parsed.access_version) ||
      parsed.exp <= nowSeconds ||
      parsed.iat > nowSeconds + 60 ||
      parsed.exp - parsed.iat !== SESSION_TTL_SECONDS
    ) {
      return null;
    }

    parsed.access = validateAccessMap(parsed.access);
    return parsed;
  } catch {
    return null;
  }
}

async function sessionFromRequest(request, secret) {
  const token = readCookie(
    request.headers.get("Cookie") || "",
    SESSION_COOKIE
  );

  if (!token) return null;

  return await readSessionToken(token, secret);
}

async function sign(value, secret) {
  const key = await hmacKey(secret, ["sign"]);

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value)
  );

  return new Uint8Array(signature);
}

async function hmacKey(secret, usages) {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages
  );
}

async function loginLimiterKey(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(ip)
  );

  return base64UrlEncode(new Uint8Array(digest));
}

function readCookie(header, name) {
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}

function sessionCookie(token) {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);

  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function statusForCode(code) {
  if (/ORIGINE|ACTION_REFUSEE|ACCES_REFUSE/.test(code)) return 403;
  if (/AUTH|CODE_INVALIDE/.test(code)) return 401;
  if (/LIEN_SIGNATURE_INVALIDE/.test(code)) return 410;
  if (/INTROUVABLE|MANQUANT$/.test(code)) return 404;
  if (/IMMUABLE|EXISTANT|INCOHERENT|DUPLIQUE|VERROUILLEE|EN_ATTENTE|MODIFIE_APRES_ENVOI|DEJA_RECUE/.test(code)) return 409;
  if (/TROP_VOLUMINEUX/.test(code)) return 413;
  if (/TIMEOUT_GOOGLE/.test(code)) return 504;

  if (
    /CONFIG|SERVICE_AVANCE|CONVERSION|GENERATION|VERIFICATION|REPONSE_GOOGLE/.test(code)
  ) {
    return 502;
  }

  return 400;
}

function publicMessage(code, fallback) {
  if (/LIEN_SIGNATURE_INVALIDE/.test(code)) {
    return "Ce lien de signature est invalide, expiré ou n’est plus actif.";
  }
  if (/SIGNATURE_AGENT_REQUISE/.test(code)) {
    return "La signature de l’agent est requise.";
  }
  if (/CONTENU_EVALUATION_MODIFIE_APRES_ENVOI/.test(code)) {
    return "Cette évaluation a été modifiée depuis l’envoi. Demandez un nouveau lien de signature.";
  }
  if (/EVALUATION_VERROUILLEE_SIGNATURE_AGENT/.test(code)) {
    return "Cette évaluation est verrouillée pendant la signature de l’agent. Annulez la demande pour la modifier.";
  }
  if (/SIGNATURE_AGENT_EN_ATTENTE/.test(code)) {
    return "La signature de l’agent est encore en attente.";
  }
  if (/SIGNATURE_AGENT_DEJA_RECUE/.test(code)) {
    return "La signature de l’agent a déjà été reçue.";
  }
  if (/TIMEOUT_GOOGLE/.test(code)) {
    return fallback || "Le service de données met trop de temps à répondre. Réessayez.";
  }

  if (
    /CONFIG|SERVICE_AVANCE|CONVERSION|GENERATION|VERIFICATION|REPONSE_GOOGLE/.test(code)
  ) {
    return "Le service est temporairement indisponible.";
  }

  if (/ACCES_REFUSE/.test(code)) {
    return "Cette rubrique n’est pas autorisée pour votre profil.";
  }

  if (/ACCES|AUTH|CODE/.test(code)) {
    return "Code incorrect ou accès non autorisé.";
  }

  return fallback || "La demande n’a pas pu être traitée.";
}

function responseHeaders(origin, extra = {}) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-site",
    Vary: "Origin"
  });

  if (ALLOWED_ORIGINS.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
    headers.set("Access-Control-Max-Age", "86400");
  }

  const additions = new Headers(extra);
  additions.forEach((value, key) => headers.set(key, value));

  return headers;
}

function apiJson(data, status, origin, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: responseHeaders(origin, extra)
  });
}

function apiError(code, message, status, origin, extra = {}) {
  return apiJson({ ok: false, code, message }, status, origin, extra);
}

export { createSessionToken, readSessionToken };
