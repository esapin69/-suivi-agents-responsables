import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";
import { ensureSchema } from "../src/schema";

const origin = "https://responsable.esapin.com";
const runtime = env as unknown as Env;
const signatureDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const appsScript = {
  code: "123456",
  sessionVersion: "annuaire-session-version-0123456789abcdef",
  traineeAccess: true,
};

function annuaireUser() {
  return {
    id: "annuaire-eddy",
    nom: "SAPIN",
    prenom: "Eddy",
    poste: "Responsable",
    display_name: "Eddy SAPIN",
    is_admin: true,
    access: { nouveau_stagiaire: appsScript.traineeAccess, suivi_des_agents: true },
  };
}

beforeEach(() => {
  appsScript.code = "123456";
  appsScript.sessionVersion = "annuaire-session-version-0123456789abcdef";
  appsScript.traineeAccess = true;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== "https://apps-script.test") return new Response("not mocked", { status: 502 });

    if (request.method === "POST") {
      const form = await request.formData();
      const payload = JSON.parse(String(form.get("payload") || "{}")) as Record<string, unknown>;
      if (payload.action === "authenticateAccess" && payload.code === appsScript.code) {
        return Response.json({ ok: true, user: annuaireUser(), session_version: appsScript.sessionVersion });
      }
      return Response.json({ ok: false, code: "AUTH_INVALIDE" });
    }

    if (url.searchParams.get("action") === "authorizeAccess") {
      const valid = url.searchParams.get("auth_user_id") === annuaireUser().id
        && url.searchParams.get("auth_session_version") === appsScript.sessionVersion;
      return Response.json(valid ? { ok: true, user: annuaireUser() } : { ok: false, code: "AUTH_REQUISE" });
    }
    return Response.json({ ok: false, code: "ACTION_INCONNUE" });
  }));
});

afterEach(() => vi.unstubAllGlobals());

async function api(path: string, options: { method?: string; body?: unknown; cookie?: string } = {}): Promise<Response> {
  const headers = new Headers({ Origin: origin, Accept: "application/json" });
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (options.cookie) headers.set("Cookie", options.cookie);
  return worker.fetch(new Request(`https://responsable-api.esapin.com${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }), runtime);
}

function sessionCookie(response: Response): string {
  const value = response.headers.get("Set-Cookie") || "";
  return value.split(";")[0] || "";
}

async function responseJson(response: Response): Promise<any> {
  const data = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(data)}`);
  return data;
}

describe("parcours complet d’une fiche stagiaire", () => {
  it("initialise D1 sans aucun code ni mot de passe du personnel", async () => {
    const testEnv = env as unknown as {
      FRESH_DB: D1Database;
      TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
    };
    const fresh = testEnv.FRESH_DB;
    await applyD1Migrations(fresh, [testEnv.TEST_MIGRATIONS[0]!]);
    const now = new Date().toISOString();
    await fresh.prepare(
      `INSERT INTO users
        (id, first_name, last_name, display_name, position, role, permissions_json, pin_lookup, pin_salt, pin_hash, pin_iterations, session_version, legacy_access_version, active, created_at, updated_at)
       VALUES ('old-user', 'Eddy', 'SAPIN', 'Eddy SAPIN', 'Responsable', 'ADMIN', '{"nouveau_stagiaire":true}', 'lookup', 'salt', 'hash', 210000, 'session', 'legacy', 1, ?, ?)`,
    ).bind(now, now).run();
    await ensureSchema({ ...runtime, DB: fresh });
    const row = await fresh.prepare("SELECT MAX(version) AS version FROM app_schema_migrations").first<{ version: number }>();
    expect(row?.version).toBe(2);
    const columns = await fresh.prepare("PRAGMA table_info(users)").all<{ name: string }>();
    expect(columns.results.map(column => column.name)).toEqual([
      "id", "first_name", "last_name", "display_name", "position", "role",
      "permissions_json", "last_verified_at", "created_at", "updated_at",
    ]);
    expect(await fresh.prepare("SELECT display_name FROM users WHERE id = 'old-user'").first<{ display_name: string }>()).toEqual({ display_name: "Eddy SAPIN" });
  });

  it("relit immédiatement le code et la colonne OK de l’Annuaire", async () => {
    const loginResponse = await api("/v2/auth/login", { method: "POST", body: { code: "123456" } });
    const userCookie = sessionCookie(loginResponse);
    expect(loginResponse.status).toBe(200);
    expect((await api("/v2/admin/users", { cookie: userCookie })).status).toBe(404);

    appsScript.traineeAccess = false;
    const portalSession = await api("/?action=session", { cookie: userCookie });
    expect(portalSession.status).toBe(200);
    expect((await portalSession.json() as any).user.access.nouveau_stagiaire).toBe(false);
    const blockedModule = await api("/v2/trainees", { cookie: userCookie });
    expect(blockedModule.status).toBe(403);
    expect((await blockedModule.json() as any).code).toBe("ACCES_REFUSE");

    appsScript.traineeAccess = true;
    appsScript.sessionVersion = "annuaire-session-version-changed-0123456789";
    const expiredSession = await api("/?action=session", { cookie: userCookie });
    expect(expiredSession.status).toBe(401);
    expect(expiredSession.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  it("conserve, signe, clôture, fige puis crée une nouvelle version", async () => {

    const loginResponse = await api("/v2/auth/login", { method: "POST", body: { code: "123456" } });
    expect(loginResponse.status).toBe(200);
    const userCookie = sessionCookie(loginResponse);
    expect(userCookie).toContain("__Host-ghe_session=");

    const created = await responseJson(await api("/v2/trainees", {
      method: "POST",
      cookie: userCookie,
      body: {
        firstName: "Camille",
        lastName: "Martin",
        email: "camille@example.test",
        phone: "0600000000",
        school: "Institut de formation",
        startDate: "2026-09-01",
        endDate: "2026-09-30",
        tutorName: "Eddy Sapin",
        arrivalNotes: "Accueil réalisé et consignes remises.",
      },
    }));
    const traineeId = created.record.trainee.id as string;
    expect(created.record.trainee.recordVersion).toBe(1);

    const share = await responseJson(await api(`/v2/trainees/${traineeId}/share-link`, {
      method: "POST", cookie: userCookie, body: { expiresDays: 30 },
    }));
    const rawToken = new URL(share.link).searchParams.get("token");
    expect(rawToken).toBeTruthy();
    const exchange = await api("/v2/share/exchange", { method: "POST", body: { token: rawToken } });
    expect(exchange.status).toBe(200);
    const traineeCookie = sessionCookie(exchange);

    await responseJson(await api(`/v2/trainees/${traineeId}/self-section`, {
      method: "PUT",
      cookie: traineeCookie,
      body: { expectations: "Découvrir le métier.", progress: "Je gagne en autonomie.", feedback: "Stage formateur.", comments: "", expectedVersion: 1 },
    }));
    await responseJson(await api(`/v2/trainees/${traineeId}/self-section/signature`, {
      method: "POST", cookie: traineeCookie, body: { signatureDataUrl, expectedVersion: 1 },
    }));

    const observed = await responseJson(await api(`/v2/trainees/${traineeId}/observations`, {
      method: "POST",
      cookie: userCookie,
      body: { category: "SECURITE_HYGIENE", observedOn: "2026-09-10", content: "Respecte les procédures observées lors du transfert.", expectedVersion: 1 },
    }));
    const observationId = observed.record.observations[0].id as string;
    await responseJson(await api(`/v2/trainees/${traineeId}/observations/${observationId}/signature`, {
      method: "POST", cookie: userCookie, body: { signatureDataUrl, expectedVersion: 1 },
    }));

    await expect(runtime.DB.prepare("UPDATE observations SET content = 'altéré' WHERE id = ?").bind(observationId).run()).rejects.toThrow(/IMMUABLE/);

    const ratings = {
      autonomy: 3,
      techniqueHandling: 3,
      safetyHygiene: 4,
      communication: 3,
      organization: 3,
      professionalBehavior: 4,
    };
    await responseJson(await api(`/v2/trainees/${traineeId}/final-evaluation`, {
      method: "PUT",
      cookie: userCookie,
      body: { ratings, strengths: "Attentif et fiable.", improvements: "Poursuivre la prise d’initiative.", summary: "Stage satisfaisant.", expectedVersion: 1 },
    }));
    await responseJson(await api(`/v2/trainees/${traineeId}/final-evaluation/signature`, {
      method: "POST", cookie: userCookie, body: { signatureDataUrl, expectedVersion: 1 },
    }));
    await responseJson(await api(`/v2/trainees/${traineeId}/final-evaluation/signature`, {
      method: "POST", cookie: traineeCookie, body: { signatureDataUrl, expectedVersion: 1 },
    }));

    const closed = await responseJson(await api(`/v2/trainees/${traineeId}/close`, {
      method: "POST", cookie: userCookie, body: { expectedVersion: 1 },
    }));
    expect(closed.record.trainee.status).toBe("CLOSED");
    expect(closed.document.sha256).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const download = await api(`/v2/trainees/${traineeId}/documents/1`, { cookie: traineeCookie });
    expect(download.status).toBe(200);
    expect(download.headers.get("Content-Type")).toBe("application/pdf");
    expect(new TextDecoder().decode((await download.arrayBuffer()).slice(0, 4))).toBe("%PDF");

    const versioned = await responseJson(await api(`/v2/trainees/${traineeId}/new-version`, {
      method: "POST", cookie: userCookie, body: { expectedVersion: 1 },
    }));
    expect(versioned.record.trainee.status).toBe("OPEN");
    expect(versioned.record.trainee.recordVersion).toBe(2);
    expect(versioned.record.documents).toHaveLength(1);
    expect(versioned.record.observations).toHaveLength(1);
    expect(versioned.record.observations[0]).toMatchObject({
      id: observationId,
      recordVersion: 1,
      signed: true,
      canEdit: false,
    });
    expect(versioned.record.signatures).toHaveLength(1);
    expect(versioned.record.signatures[0]).toMatchObject({
      scopeType: "OBSERVATION",
      scopeId: observationId,
    });
  }, 30_000);
});
