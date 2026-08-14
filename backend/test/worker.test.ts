import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { createSessionToken } from "../src/index";

const allowedOrigin = "https://responsable.esapin.com";
const secret = "0123456789abcdef0123456789abcdef";
const sessionVersion = "test-session-version-0123456789abcdef";

const baseUser = {
  id: "TEST|RESPONSABLE",
  nom: "TEST",
  prenom: "RESPONSABLE",
  poste: "Chef",
  display_name: "RESPONSABLE TEST",
  is_admin: false,
};

function limiter(success = true) {
  return { async limit() { return { success }; } };
}

function env() {
  return {
    APPS_SCRIPT_URL: "https://script.example.test/exec",
    APPS_SCRIPT_KEY: "server-secret",
    SESSION_SECRET: secret,
    LOGIN_IP_LIMITER: limiter(),
    LOGIN_GLOBAL_LIMITER: limiter(),
  };
}

function executionContext() {
  return {
    waitUntil(promise: Promise<unknown>) { void promise.catch(() => undefined); },
    passThroughOnException() {},
  };
}

function request(action: string, init: RequestInit = {}, params: Record<string, string> = {}) {
  const url = new URL("https://responsable-api.esapin.com/");
  url.searchParams.set("action", action);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const headers = new Headers(init.headers);
  headers.set("Origin", allowedOrigin);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return new Request(url, { ...init, headers });
}

async function token(access: Record<string, boolean> = {}) {
  return await createSessionToken({
    ...baseUser,
    access,
    access_version: sessionVersion,
  }, secret);
}

afterEach(() => vi.unstubAllGlobals());

describe("canonical Cloudflare authentication gateway", () => {
  it("rejects a protected request without a session", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const response = await worker.fetch(request("getAgent", {}, { id: "A-1" }), env(), executionContext());
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "AUTH_REQUISE" });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects an untrusted origin before contacting Apps Script", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const bad = new Request("https://responsable-api.esapin.com/?action=login", {
      method: "POST",
      headers: { Origin: "https://example.org", "Content-Type": "application/json" },
      body: JSON.stringify({ code: "123456" }),
    });
    const response = await worker.fetch(bad, env(), executionContext());
    expect(response.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("creates a secure session only after Apps Script validates the code", async () => {
    const upstream = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      user: { ...baseUser, access: {} },
      session_version: sessionVersion,
    })));
    vi.stubGlobal("fetch", upstream);

    const response = await worker.fetch(
      request("login", { method: "POST", body: JSON.stringify({ code: "123456" }) }),
      env(),
      executionContext(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toContain("__Host-ghe_session=");
    expect(response.headers.get("Set-Cookie")).toContain("HttpOnly");
    expect(response.headers.get("Set-Cookie")).toContain("Secure");
    expect(response.headers.get("Set-Cookie")).toContain("SameSite=Strict");
    expect(upstream).toHaveBeenCalledTimes(1);

    const body = String(upstream.mock.calls[0][1]?.body || "");
    const form = new URLSearchParams(body);
    const payload = JSON.parse(form.get("payload") || "{}");
    expect(payload).toMatchObject({ action: "authenticateAccess", code: "123456", key: "server-secret" });
  });

  it("forwards the opaque access version on protected data requests", async () => {
    const session = await token({ suivi_des_agents: true });
    let calledUrl = "";
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      calledUrl = String(input);
      return new Response(JSON.stringify({ ok: true, agent: { id_agent: "A-1" } }));
    });
    vi.stubGlobal("fetch", upstream);

    const response = await worker.fetch(request("getAgent", {
      headers: { Cookie: `__Host-ghe_session=${session}` },
    }, { id: "A-1" }), env(), executionContext());

    expect(response.status).toBe(200);
    const upstreamUrl = new URL(calledUrl);
    expect(upstreamUrl.searchParams.get("action")).toBe("getAgent");
    expect(upstreamUrl.searchParams.get("auth_user_id")).toBe(baseUser.id);
    expect(upstreamUrl.searchParams.get("auth_session_version")).toBe(sessionVersion);
    expect(upstreamUrl.searchParams.get("id")).toBe("A-1");
  });

  it("enforces local rubrique access before using the shared agent cache", async () => {
    const session = await token({});
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const response = await worker.fetch(request("listAgents", {
      headers: { Cookie: `__Host-ghe_session=${session}` },
    }), env(), executionContext());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "ACCES_REFUSE" });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects a malformed code without contacting Apps Script", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const response = await worker.fetch(
      request("login", { method: "POST", body: JSON.stringify({ code: "123" }) }),
      env(),
      executionContext(),
    );
    expect(response.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rate-limits login attempts before checking a code", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const limited = env();
    limited.LOGIN_IP_LIMITER = limiter(false);
    const response = await worker.fetch(
      request("login", { method: "POST", body: JSON.stringify({ code: "123456" }) }),
      limited,
      executionContext(),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("keeps public signature actions sessionless but server-key protected upstream", async () => {
    const upstream = vi.fn(async () => new Response(JSON.stringify({ ok: true, request: { status: "PENDING" } })));
    vi.stubGlobal("fetch", upstream);
    const response = await worker.fetch(request("publicGetAgentSignature", {
      method: "POST",
      body: JSON.stringify({ token: "opaque-token" }),
    }), env(), executionContext());
    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    const body = String(upstream.mock.calls[0][1]?.body || "");
    const form = new URLSearchParams(body);
    const payload = JSON.parse(form.get("payload") || "{}");
    expect(payload).toMatchObject({ action: "publicGetAgentSignature", token: "opaque-token", key: "server-secret" });
  });

  it("answers health checks without contacting Apps Script", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const response = await worker.fetch(
      new Request("https://responsable-api.esapin.com/?action=health"),
      env(),
      executionContext(),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, service: "suivi-agents", bridge: "cloudflare" });
    expect(upstream).not.toHaveBeenCalled();
  });
});
