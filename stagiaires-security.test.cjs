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

test("le lien stagiaire peut être préparé dans un SMS sans prestataire externe", () => {
  const source = fs.readFileSync(projectFile("stagiaires.js"), "utf8");
  const html = fs.readFileSync(projectFile("fiche-stagiaire.html"), "utf8");
  assert.match(source, /sms:\$\{recipient\}\?body=/);
  assert.match(source, /Vous pouvez compléter votre partie, l’enregistrer pour y revenir plus tard/);
  assert.match(source, /navigator\.clipboard\.writeText/);
  assert.match(html, /id="shareBySms"/);
  assert.doesNotMatch(source, /twilio|vonage|messagebird/i);
});

test("l’interface distingue témoignage, expression personnelle et prise de connaissance", () => {
  const source = fs.readFileSync(projectFile("stagiaires.js"), "utf8");
  const html = fs.readFileSync(projectFile("fiche-stagiaire.html"), "utf8");
  const pdf = fs.readFileSync(projectFile("cloudflare", "src", "pdf.ts"), "utf8");
  assert.match(source, /Elle ne signifie pas que vous approuvez chaque appréciation/);
  assert.match(html, /Sa signature atteste uniquement les propos qu’il a lui-même écrits/);
  assert.match(pdf, /sans valoir accord avec chaque appréciation/);
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
