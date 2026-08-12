import type { Env, Principal, Role, TraineePrincipal } from "./types";
import { ApiError } from "./http";

const USER_COOKIE = "__Host-ghe_session";
const TRAINEE_COOKIE = "__Host-ghe_trainee";
const USER_SESSION_TTL = 8 * 60 * 60;

type SessionPayloadV2 = {
  version: 2;
  kind: "user";
  principal: Principal;
  legacyAccessVersion: string;
  iat: number;
  exp: number;
};

type LegacySessionPayload = {
  version: 1;
  id: string;
  nom: string;
  prenom: string;
  poste: string;
  display_name: string;
  is_admin: boolean;
  access: Record<string, boolean>;
  access_version: string;
  iat: number;
  exp: number;
};

type TraineeSessionPayload = TraineePrincipal & {
  version: 1;
  iat: number;
  exp: number;
};

export type UserSession = {
  principal: Principal;
  legacyAccessVersion: string;
};

export function requireSessionSecret(env: Env): void {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
    throw new Error("SESSION_SECRET_MANQUANT");
  }
}

export async function createUserSessionToken(
  principal: Principal,
  legacyAccessVersion: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const payload: SessionPayloadV2 = {
    version: 2,
    kind: "user",
    principal,
    legacyAccessVersion,
    iat: nowSeconds,
    exp: nowSeconds + USER_SESSION_TTL,
  };
  return signPayload(payload, secret);
}

export async function readUserSessionToken(
  token: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<UserSession | null> {
  const payload = await verifyPayload(token, secret);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const candidate = payload as Record<string, unknown>;
  if (candidate.version === 2) {
    const current = candidate as Partial<SessionPayloadV2>;
    if (current.kind !== "user" || !validTimes(current.iat, current.exp, nowSeconds, USER_SESSION_TTL)) return null;
    const principal = validatePrincipal(current.principal);
    if (!principal || typeof current.legacyAccessVersion !== "string") return null;
    return { principal, legacyAccessVersion: current.legacyAccessVersion };
  }
  if (candidate.version === 1) {
    const legacy = candidate as Partial<LegacySessionPayload>;
    if (!validTimes(legacy.iat, legacy.exp, nowSeconds, USER_SESSION_TTL)) return null;
    if (!legacy.id || !legacy.nom || !legacy.prenom || !legacy.display_name || typeof legacy.is_admin !== "boolean") return null;
    if (!legacy.access_version || !/^[A-Za-z0-9_-]{32,128}$/.test(legacy.access_version)) return null;
    const access = normalizeAccess(legacy.access);
    return {
      principal: {
        id: legacy.id,
        firstName: legacy.prenom,
        lastName: legacy.nom,
        displayName: legacy.display_name,
        position: legacy.poste || "",
        role: inferRole(legacy.is_admin, legacy.poste || ""),
        source: "legacy",
        sessionVersion: legacy.access_version,
        access,
      },
      legacyAccessVersion: legacy.access_version,
    };
  }
  return null;
}

export async function userSessionFromRequest(request: Request, env: Env): Promise<UserSession> {
  const token = readCookie(request.headers.get("Cookie") || "", USER_COOKIE);
  const session = token ? await readUserSessionToken(token, env.SESSION_SECRET) : null;
  if (!session) throw new ApiError("AUTH_REQUISE", "Votre session a expiré. Reconnectez-vous.", 401);
  return session;
}

export async function createTraineeSessionToken(
  linkId: string,
  traineeId: string,
  expiresAt: number,
  secret: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: TraineeSessionPayload = {
    version: 1,
    kind: "trainee",
    linkId,
    traineeId,
    expiresAt,
    iat: now,
    exp: Math.min(expiresAt, now + 30 * 24 * 60 * 60),
  };
  return signPayload(payload, secret);
}

export async function traineeSessionFromRequest(request: Request, env: Env): Promise<TraineePrincipal> {
  const token = readCookie(request.headers.get("Cookie") || "", TRAINEE_COOKIE);
  const payload = token ? await verifyPayload(token, env.SESSION_SECRET) : null;
  const now = Math.floor(Date.now() / 1000);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new ApiError("LIEN_REQUIS", "Ce lien stagiaire n’est plus valide.", 401);
  const value = payload as Partial<TraineeSessionPayload>;
  if (value.version !== 1 || value.kind !== "trainee" || !value.linkId || !value.traineeId || !value.expiresAt || !validTimes(value.iat, value.exp, now)) {
    throw new ApiError("LIEN_REQUIS", "Ce lien stagiaire n’est plus valide.", 401);
  }
  const row = await env.DB.prepare(
    "SELECT id, trainee_id, expires_at FROM access_links WHERE id = ? AND trainee_id = ? AND revoked_at IS NULL AND expires_at > ?",
  ).bind(value.linkId, value.traineeId, new Date().toISOString()).first<{ id: string; trainee_id: string; expires_at: string }>();
  if (!row) throw new ApiError("LIEN_EXPIRE", "Ce lien stagiaire a expiré ou a été révoqué.", 401);
  return { kind: "trainee", linkId: row.id, traineeId: row.trainee_id, expiresAt: Date.parse(row.expires_at) / 1000 };
}

export function publicUser(principal: Principal): Record<string, unknown> {
  return {
    id: principal.id,
    nom: principal.lastName,
    prenom: principal.firstName,
    poste: principal.position,
    display_name: principal.displayName,
    is_admin: principal.role === "ADMIN",
    role: principal.role,
    access: principal.access,
  };
}

export function requireRole(principal: Principal, roles: Role[]): void {
  if (!roles.includes(principal.role)) throw new ApiError("ACCES_REFUSE", "Vous n’avez pas l’autorisation nécessaire.", 403);
}

export function requireAccess(principal: Principal, key: string): void {
  if (principal.access[key] !== true) throw new ApiError("ACCES_REFUSE", "Vous n’avez pas l’autorisation nécessaire.", 403);
}

export function inferRole(isAdmin: boolean, position: string): Role {
  if (isAdmin) return "ADMIN";
  return /chef|responsable|encadrant/i.test(position) ? "CHEF" : "AGENT";
}

export function randomToken(bytes = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export async function sha256Text(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}

export async function sha256Bytes(value: ArrayBuffer | ArrayBufferView): Promise<string> {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return base64UrlEncode(new Uint8Array(digest));
}

export async function limiterKey(request: Request): Promise<string> {
  return sha256Text(request.headers.get("CF-Connecting-IP") || "unknown");
}

export function userCookie(token: string): string {
  return `${USER_COOKIE}=${token}; Path=/; Max-Age=${USER_SESSION_TTL}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearUserCookie(): string {
  return `${USER_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

export function traineeCookie(token: string, maxAge: number): string {
  return `${TRAINEE_COOKIE}=${token}; Path=/; Max-Age=${Math.max(0, maxAge)}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearTraineeCookie(): string {
  return `${TRAINEE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

async function signPayload(payload: object, secret: string): Promise<string> {
  const encoded = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await hmacBytes(encoded, secret);
  return `${encoded}.${base64UrlEncode(signature)}`;
}

async function verifyPayload(token: string, secret: string): Promise<unknown | null> {
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra) return null;
  try {
    const expected = await hmacBytes(encoded, secret);
    if (!timingSafeEqual(expected, base64UrlDecode(signature))) return null;
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(encoded)));
  } catch {
    return null;
  }
}

async function hmacBytes(value: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

function validatePrincipal(value: unknown): Principal | null {
  if (!value || Array.isArray(value) || typeof value !== "object") return null;
  const p = value as Partial<Principal>;
  if (!p.id || !p.firstName || !p.lastName || !p.displayName || typeof p.position !== "string" || !p.sessionVersion) return null;
  if (!p.role || !["ADMIN", "CHEF", "AGENT"].includes(p.role)) return null;
  if (p.source !== "legacy") return null;
  return { ...p, access: normalizeAccess(p.access) } as Principal;
}

function validTimes(iat: unknown, exp: unknown, now: number, exactTtl?: number): boolean {
  if (typeof iat !== "number" || typeof exp !== "number") return false;
  if (exp <= now || iat > now + 60 || exp <= iat) return false;
  return exactTtl === undefined || exp - iat === exactTtl;
}

function normalizeAccess(value: unknown): Record<string, boolean> {
  if (!value || Array.isArray(value) || typeof value !== "object") return {};
  const result: Record<string, boolean> = {};
  for (const [key, allowed] of Object.entries(value as Record<string, unknown>)) {
    if (/^[a-z0-9_]{1,80}$/.test(key) && typeof allowed === "boolean") result[key] = allowed;
  }
  return result;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= (a[index] || 0) ^ (b[index] || 0);
  return difference === 0;
}

function readCookie(header: string, name: string): string {
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
}
