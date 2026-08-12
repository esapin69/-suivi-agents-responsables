export const ALLOWED_ORIGIN = "https://responsable.esapin.com";
export const MAX_JSON_BYTES = 300_000;
export const MAX_SIGNATURE_BYTES = 180_000;

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export function assertAllowedOrigin(request: Request): string {
  const origin = request.headers.get("Origin") || "";
  if (origin !== ALLOWED_ORIGIN) {
    throw new ApiError("ORIGINE_REFUSEE", "Origine non autorisée.", 403);
  }
  return origin;
}

export function responseHeaders(origin = "", extra: HeadersInit = {}): Headers {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-site",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    Vary: "Origin",
  });
  if (origin === ALLOWED_ORIGIN) {
    headers.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type, If-Match");
    headers.set("Access-Control-Max-Age", "86400");
  }
  const additions = new Headers(extra);
  additions.forEach((value, key) => headers.set(key, value));
  return headers;
}

export function json(data: unknown, status = 200, origin = "", extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: responseHeaders(origin, extra) });
}

export function noContent(origin = "", extra: HeadersInit = {}): Response {
  const headers = responseHeaders(origin, extra);
  headers.delete("Content-Type");
  return new Response(null, { status: 204, headers });
}

export function errorResponse(error: unknown, origin = ""): Response {
  if (error instanceof ApiError) {
    return json(
      { ok: false, code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
      error.status,
      origin,
      error.status === 429 ? { "Retry-After": "60" } : {},
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ event: "unhandled_error", message }));
  return json({ ok: false, code: "ERREUR_INTERNE", message: "Le service est temporairement indisponible." }, 500, origin);
}

export async function readJson(request: Request, maxBytes = MAX_JSON_BYTES): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > maxBytes) throw new ApiError("CORPS_TROP_VOLUMINEUX", "Données trop volumineuses.", 413);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) {
    throw new ApiError("CORPS_TROP_VOLUMINEUX", "Données trop volumineuses.", 413);
  }
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("invalid shape");
    return parsed as Record<string, unknown>;
  } catch {
    throw new ApiError("JSON_INVALIDE", "Les données envoyées sont invalides.", 400);
  }
}

export function routeMatch(pathname: string, pattern: RegExp): RegExpMatchArray | null {
  return pathname.match(pattern);
}

export function requireMethod(request: Request, expected: string): void {
  if (request.method !== expected) throw new ApiError("METHODE_REFUSEE", "Méthode non autorisée.", 405);
}

export function validationError(issues: unknown): ApiError {
  return new ApiError("DONNEES_INVALIDES", "Certains champs sont incomplets ou invalides.", 422, issues);
}

export function safeFilename(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "document";
}
