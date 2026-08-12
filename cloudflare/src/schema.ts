import initialSchema from "../migrations/0001_initial.sql";
import xlAccessAuthoritySchema from "../migrations/0002_xl_access_authority.sql";
import type { Env } from "./types";

const CURRENT_SCHEMA_VERSION = 2;

const MIGRATIONS = [
  { version: 1, source: initialSchema },
  { version: 2, source: xlAccessAuthoritySchema },
];

export async function ensureSchema(env: Env): Promise<number> {
  let currentVersion = 0;
  try {
    const row = await env.DB.prepare("SELECT MAX(version) AS version FROM app_schema_migrations").first<{ version: number | null }>();
    currentVersion = Number(row?.version || 0);
    if (currentVersion >= CURRENT_SCHEMA_VERSION) return CURRENT_SCHEMA_VERSION;
  } catch {
    // Première exécution : la table de suivi n'existe pas encore.
  }
  // D1 exec() traite chaque ligne comme une requête. Le fichier reste lisible
  // et compatible avec Wrangler ; ici chaque requête (y compris les triggers)
  // est ramenée sur une seule ligne avant l'initialisation automatique.
  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) await env.DB.exec(toExecScript(migration.source));
  }
  const row = await env.DB.prepare("SELECT MAX(version) AS version FROM app_schema_migrations").first<{ version: number | null }>();
  const version = Number(row?.version || 0);
  if (version < CURRENT_SCHEMA_VERSION) throw new Error("SCHEMA_INITIALIZATION_FAILED");
  return version;
}

function toExecScript(source: string): string {
  const statements: string[] = [];
  let current = "";
  let trigger = false;
  for (const rawLine of source.replace(/\r/g, "").split("\n")) {
    const line = rawLine.replace(/--.*$/, "").trim();
    if (!line || /^PRAGMA\s+foreign_keys/i.test(line)) continue;
    if (!current && /^CREATE\s+TRIGGER\b/i.test(line)) trigger = true;
    current += `${current ? " " : ""}${line}`;
    const complete = trigger ? /\bEND;$/i.test(line) : /;$/i.test(line);
    if (complete) {
      statements.push(current);
      current = "";
      trigger = false;
    }
  }
  if (current) throw new Error("SCHEMA_PARSE_INCOMPLETE");
  return statements.join("\n");
}
