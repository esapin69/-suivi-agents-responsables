const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const files = ["nouveau-stagiaire.html", "fiche-stagiaire.html"];
const projectFile = (...parts) => path.join(__dirname, ...parts);

test("les pages stagiaires appliquent une politique de sécurité avant les scripts", () => {
  for (const file of files) {
    const html = fs.readFileSync(projectFile(file), "utf8");
    const csp = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)">/i);
    assert.ok(csp, `${file}: CSP manquante`);
    assert.ok(html.indexOf(csp[0]) < html.search(/<script\b/i), `${file}: CSP trop tardive`);
    assert.match(csp[1], /connect-src 'self' https:\/\/responsable-api\.esapin\.com/);
    assert.match(csp[1], /script-src 'self'/);
    assert.match(csp[1], /script-src-attr 'none'/);
    assert.doesNotMatch(csp[1], /script-src[^;]*'unsafe-inline'/);
    assert.match(html, /<meta name="robots" content="noindex,nofollow">/);
    assert.match(html, /<meta name="referrer" content="no-referrer">/);
    assert.doesNotMatch(html, /<[^>]+\son[a-z]+\s*=/i, `${file}: gestionnaire inline interdit`);
    assert.doesNotMatch(html, /script\.google|googleusercontent|workers\.dev/i);
  }
});

test("le lien stagiaire est échangé contre un cookie puis retiré de l’adresse", () => {
  const source = fs.readFileSync(projectFile("stagiaires.js"), "utf8");
  assert.match(source, /\/v2\/share\/exchange/);
  assert.match(source, /history\.replaceState/);
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
});

test("les éléments signés et les documents disposent de verrous en base", () => {
  const schema = fs.readFileSync(projectFile("cloudflare", "migrations", "0001_initial.sql"), "utf8");
  for (const trigger of [
    "signatures_immutable_update",
    "documents_immutable_update",
    "audit_immutable_update",
    "signed_observation_immutable_update",
    "signed_self_section_immutable_update",
    "signed_final_evaluation_content_immutable",
  ]) assert.match(schema, new RegExp(`CREATE TRIGGER IF NOT EXISTS ${trigger}`));
});
