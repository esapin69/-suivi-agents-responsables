const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "Code.gs"), "utf8");

function signedBytes(buffer) {
  return Array.from(buffer, byte => byte > 127 ? byte - 256 : byte);
}

function runtime(rows) {
  const scriptProperties = { API_KEY: "test-api-key-with-at-least-32-characters" };
  const context = {
    console,
    Date,
    PropertiesService: {
      getScriptProperties() {
        return { getProperty: name => scriptProperties[name] || null };
      },
    },
    Utilities: {
      Charset: { UTF_8: "UTF-8" },
      DigestAlgorithm: { SHA_256: "SHA_256" },
      computeDigest(_algorithm, value) {
        return signedBytes(crypto.createHash("sha256").update(String(value)).digest());
      },
      computeHmacSha256Signature(value, secret) {
        return signedBytes(crypto.createHmac("sha256", String(secret)).update(String(value)).digest());
      },
      base64EncodeWebSafe(bytes) {
        return Buffer.from(bytes.map(byte => byte & 255)).toString("base64url");
      },
      formatDate(value) {
        return value.toISOString().slice(0, 10);
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  context.accessRows_ = () => rows;
  return context;
}

function row({ id, nom, prenom, poste, code, access = {} }) {
  return { id, nom, prenom, poste, code, access };
}

test("a unique six-digit code authenticates any listed person without exposing the code", () => {
  const rows = [row({
    id: "TEST|ALICE",
    nom: "TEST",
    prenom: "Alice",
    poste: "Agent de jour",
    code: "123456",
    access: { planning: true, contacts: false },
  })];
  const app = runtime(rows);
  const result = app.authenticateAccess_("123456");
  assert.equal(result.ok, true);
  assert.equal(result.user.id, "TEST|ALICE");
  assert.equal(result.user.code, undefined);
  assert.equal(result.user.access.planning, true);
  assert.equal(result.user.access.contacts, false);
  assert.match(result.session_version, /^[A-Za-z0-9_-]{43}$/);
});

test("duplicate codes and malformed codes are rejected", () => {
  const duplicateRows = [
    row({ id: "TEST|A", nom: "TEST", prenom: "A", poste: "Agent", code: "234567" }),
    row({ id: "TEST|B", nom: "TEST", prenom: "B", poste: "Chef", code: "234567" }),
  ];
  assert.throws(() => runtime(duplicateRows).authenticateAccess_("234567"), /AUTH_INVALIDE/);
  assert.throws(() => runtime([]).authenticateAccess_("12345"), /AUTH_INVALIDE/);
});

test("access is controlled by OK-derived rights, not by role", () => {
  const app = runtime([]);
  const agent = row({ id:"TEST|A", nom:"TEST", prenom:"A", poste:"Agent", code:"345678", access:{planning:true,contacts:false} });
  assert.doesNotThrow(() => app.requireAccess_(agent, "planning"));
  assert.throws(() => app.requireAccess_(agent, "contacts"), /ACCES_REFUSE/);
});

test("the named admin flag remains available without changing normal rights", () => {
  const rows = [row({
    id: "SAPIN|EDDY",
    nom: "SAPIN",
    prenom: "Eddy",
    poste: "Agent de jour",
    code: "456789",
  })];
  const result = runtime(rows).authenticateAccess_("456789");
  assert.equal(result.user.is_admin, true);
});

test("changing a code immediately invalidates the old session version", () => {
  const rows = [row({
    id: "TEST|ALICE",
    nom: "TEST",
    prenom: "Alice",
    poste: "Agent",
    code: "567890",
  })];
  const app = runtime(rows);
  const oldVersion = app.accessSessionVersion_(rows[0]);
  assert.equal(app.requireAuthorizedPrincipal_(rows[0].id, oldVersion).id, rows[0].id);
  rows[0].code = "678901";
  assert.throws(() => app.requireAuthorizedPrincipal_(rows[0].id, oldVersion), /AUTH_REQUISE/);
});

test("invalid calendar dates and spreadsheet formulas are rejected or neutralized", () => {
  const app = runtime([]);
  assert.equal(app.parseIsoDate_("2026-02-29"), null);
  assert.equal(app.parseIsoDate_("2028-02-29") instanceof Date, true);
  assert.equal(app.safeSheetText_("=IMPORTXML(\"https://example.test\")"), "'=IMPORTXML(\"https://example.test\")");
  assert.equal(app.safeSheetText_("Texte normal"), "Texte normal");
});
