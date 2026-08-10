import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import worker, { createSessionToken } from "../src/index";

const allowedOrigin = "https://responsable.esapin.com";
const secret = "0123456789abcdef0123456789abcdef";
const accessEntry = {
  id: "TEST|RESPONSABLE",
  nom: "TEST",
  prenom: "RESPONSABLE",
  poste: "Chef",
  display_name: "RESPONSABLE TEST",
  is_admin: false,
  code: "123456",
};

function limiter(success = true): RateLimit {
  return { async limit() { return { success }; } };
}

function env(): Env {
  return {
    APPS_SCRIPT_URL: "https://script.example.test/exec",
    APPS_SCRIPT_KEY: "server-secret",
    SESSION_SECRET: secret,
    ACCESS_DIRECTORY_JSON: JSON.stringify([accessEntry]),
    LOGIN_IP_LIMITER: limiter(),
    LOGIN_GLOBAL_LIMITER: limiter(),
  };
}

function accessVersion(code = accessEntry.code): string {
  return createHmac("sha256", "server-secret")
    .update(`${accessEntry.id}|${code}`)
    .digest("base64url");
}

function request(action: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("Origin", allowedOrigin);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return new Request(`https://api.responsable.esapin.com/?action=${action}`, { ...init, headers });
}

afterEach(() => vi.unstubAllGlobals());

describe("authentication gateway", () => {
  it("rejects a protected request without a session", async () => {
    const response = await worker.fetch(request("listAgents"), env());
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "AUTH_REQUISE" });
  });

  it("rejects an untrusted origin before contacting the data service", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const bad = new Request("https://api.responsable.esapin.com/?action=login", {
      method: "POST",
      headers: { Origin: "https://example.org", "Content-Type": "application/json" },
      body: JSON.stringify({ code: "123456" }),
    });
    const response = await worker.fetch(bad, env());
    expect(response.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("creates a secure session after a valid code", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);

    const response = await worker.fetch(
      request("login", { method: "POST", body: JSON.stringify({ code: "123456" }) }),
      env(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toContain("__Host-ghe_session=");
    expect(response.headers.get("Set-Cookie")).toContain("HttpOnly");
    expect(response.headers.get("Set-Cookie")).toContain("SameSite=Strict");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("forwards the opaque access version on every protected request", async () => {
    const currentAccessVersion = accessVersion();
    const token = await createSessionToken({
      id: "TEST|RESPONSABLE",
      nom: "TEST",
      prenom: "RESPONSABLE",
      poste: "Chef",
      display_name: "RESPONSABLE TEST",
      is_admin: false,
      access_version: currentAccessVersion,
    }, secret);
    let calledUrl = "";
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      calledUrl = String(input);
      return new Response(JSON.stringify({ ok: true, agents: [] }));
    });
    vi.stubGlobal("fetch", upstream);
    const response = await worker.fetch(request("listAgents", {
      headers: { Cookie: `__Host-ghe_session=${token}` },
    }), env());
    expect(response.status).toBe(200);
    const upstreamUrl = new URL(calledUrl);
    expect(upstreamUrl.searchParams.get("auth_session_version")).toBe(currentAccessVersion);
  });

  it("rejects a malformed code without contacting the data service", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const response = await worker.fetch(
      request("login", { method: "POST", body: JSON.stringify({ code: "123" }) }),
      env(),
    );
    expect(response.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rate-limits login attempts before checking a code", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const limitedEnv = env();
    limitedEnv.LOGIN_IP_LIMITER = limiter(false);
    const response = await worker.fetch(
      request("login", { method: "POST", body: JSON.stringify({ code: "123456" }) }),
      limitedEnv,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("does not reveal whether a six-digit code exists", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const response = await worker.fetch(
      request("login", { method: "POST", body: JSON.stringify({ code: "999999" }) }),
      env(),
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      message: "Code incorrect ou accès non autorisé.",
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("revokes an existing session after the synchronized code changes", async () => {
    const token = await createSessionToken({
      ...accessEntry,
      access_version: accessVersion(),
    }, secret);
    const changed = env();
    changed.ACCESS_DIRECTORY_JSON = JSON.stringify([{ ...accessEntry, code: "654321" }]);
    const response = await worker.fetch(request("session", {
      headers: { Cookie: `__Host-ghe_session=${token}` },
    }), changed);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "AUTH_REQUISE" });
  });

  it("answers health checks without depending on the legacy Apps Script action", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const response = await worker.fetch(new Request("https://api.responsable.esapin.com/?action=health"), env());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, service: "suivi-agents" });
    expect(upstream).not.toHaveBeenCalled();
  });
});
