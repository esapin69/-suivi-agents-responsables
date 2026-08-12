import type { Env } from "./types";
import { ALLOWED_ORIGIN, ApiError, assertAllowedOrigin, errorResponse, json, readJson, responseHeaders } from "./http";
import { authenticateWithPin, proxyLegacyAction, publicAuthenticatedUser } from "./legacy";
import { clearTraineeCookie, clearUserCookie, limiterKey, publicUser, requireSessionSecret, userSessionFromRequest } from "./security";
import { handleV2 } from "./trainees";
import { loginSchema } from "./schemas";
import { ensureSchema } from "./schema";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    let origin = "";
    try {
      requireSessionSecret(env);

      if (request.method === "OPTIONS") {
        origin = assertAllowedOrigin(request);
        return new Response(null, { status: 204, headers: responseHeaders(origin) });
      }

      const publicHealth = url.pathname.replace(/\/+$/, "") === "/v2/health" || (url.pathname === "/" && (url.searchParams.get("action") || "health") === "health");
      if (!publicHealth) origin = assertAllowedOrigin(request);
      else if (request.headers.get("Origin") === ALLOWED_ORIGIN) origin = ALLOWED_ORIGIN;

      if (url.pathname.startsWith("/v2/")) return await handleV2(request, env, origin);

      const action = url.searchParams.get("action") || "health";
      if (action === "health") {
        if (request.method !== "GET") throw new ApiError("METHODE_REFUSEE", "Méthode non autorisée.", 405);
        return json({ ok: true, service: "suivi-agents-responsables", traineeEngine: "/v2/health", time: new Date().toISOString() }, 200, origin);
      }
      if (action === "login") return await legacyLogin(request, env, origin);
      if (action === "logout") {
        if (request.method !== "POST") throw new ApiError("METHODE_REFUSEE", "Méthode non autorisée.", 405);
        return json({ ok: true }, 200, origin, { "Set-Cookie": clearUserCookie() });
      }
      if (action === "session") {
        if (request.method !== "GET") throw new ApiError("METHODE_REFUSEE", "Méthode non autorisée.", 405);
        let current;
        try { current = await userSessionFromRequest(request, env, true); }
        catch (error) {
          if (!(error instanceof ApiError) || error.status !== 401) throw error;
          const legacy = await userSessionFromRequest(request, env, false);
          if (legacy.principal.source !== "legacy") throw error;
          current = legacy;
        }
        return json({ ok: true, user: publicAuthenticatedUser(current.principal) }, 200, origin);
      }
      const result = await proxyLegacyAction(request, env, action);
      return json(result, 200, origin);
    } catch (error) {
      const response = errorResponse(error, origin);
      if (error instanceof ApiError && error.status === 401) {
        response.headers.append("Set-Cookie", error.code.startsWith("LIEN_") ? clearTraineeCookie() : clearUserCookie());
      }
      return response;
    }
  },
} satisfies ExportedHandler<Env>;

async function legacyLogin(request: Request, env: Env, origin: string): Promise<Response> {
  if (request.method !== "POST") throw new ApiError("METHODE_REFUSEE", "Méthode non autorisée.", 405);
  const [ipLimit, globalLimit] = await Promise.all([
    env.LOGIN_IP_LIMITER.limit({ key: await limiterKey(request) }),
    env.LOGIN_GLOBAL_LIMITER.limit({ key: "all-logins" }),
  ]);
  if (!ipLimit.success || !globalLimit.success) throw new ApiError("TROP_DE_TENTATIVES", "Trop de tentatives. Attendez une minute avant de réessayer.", 429);
  await ensureSchema(env);
  const body = await readJson(request, 2_000);
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) throw new ApiError("CODE_INVALIDE", "Code incorrect ou accès non autorisé.", 401);
  const authenticated = await authenticateWithPin(env, parsed.data.code);
  return json({ ok: true, user: publicUser(authenticated.principal) }, 200, origin, { "Set-Cookie": authenticated.cookie });
}
