const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = __dirname;
const siteDirectory = path.join(root, "Nouvelle agent et suivi");
const htmlFiles = [
  path.join(root, "index.html"),
  ...fs.readdirSync(siteDirectory)
    .filter(name => name.endsWith(".html"))
    .map(name => path.join(siteDirectory, name)),
];

function relative(file) {
  return path.relative(root, file);
}

function inlineScriptHashes(html) {
  const hashes = [];
  const pattern = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    const digest = crypto.createHash("sha256").update(match[1]).digest("base64");
    hashes.push(`'sha256-${digest}'`);
  }
  return hashes;
}

test("every page applies a restrictive policy before its first script", () => {
  for (const file of htmlFiles) {
    const html = fs.readFileSync(file, "utf8");
    const csp = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)">/i);
    assert.ok(csp, `${relative(file)} has no content security policy`);
    assert.ok(html.indexOf(csp[0]) < html.search(/<script\b/i), `${relative(file)} applies its policy too late`);
    assert.match(csp[1], /connect-src 'self' https:\/\/responsable-api\.esapin\.com/);
    assert.match(csp[1], /script-src-attr 'none'/);
    assert.doesNotMatch(csp[1], /script-src[^;]*'unsafe-inline'/);
    for (const hash of inlineScriptHashes(html)) {
      assert.ok(csp[1].includes(hash), `${relative(file)} does not authorize its expected inline script hash`);
    }
    assert.match(html, /<meta name="robots" content="noindex,nofollow">/);
    assert.match(html, /<meta name="referrer" content="no-referrer">/);
    assert.doesNotMatch(html, /<[^>]+\son[a-z]+\s*=/i, `${relative(file)} contains an inline event handler`);
  }
});

test("all private pages wait for a verified session before becoming visible", () => {
  for (const file of htmlFiles) {
    if (file.endsWith(`${path.sep}connexion.html`)) continue;
    const html = fs.readFileSync(file, "utf8");
    assert.match(html, /classList\.add\("auth-pending"\)/, `${relative(file)} has no initial auth gate`);
    assert.match(html, /app\.js\?v=\d{8}-auth-\d+/, `${relative(file)} does not load a versioned secured app client`);
  }
});

test("the published source contains no former form/email-based authentication path", () => {
  const loginFile = path.join(siteDirectory, "connexion.html");
  const loginHtml = fs.readFileSync(loginFile, "utf8");
  assert.doesNotMatch(loginHtml, /type=["']email["']|name=["']email["']/i);

  const sourceFiles = [
    ...htmlFiles,
    ...fs.readdirSync(siteDirectory)
      .filter(name => name.endsWith(".js"))
      .map(name => path.join(siteDirectory, name)),
    path.join(root, "apps-script", "Code.gs"),
    path.join(root, "apps-script", "EVALUATIONS.gs"),
  ];
  const source = sourceFiles.map(file => fs.readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(source, /workers\.dev|formResponse|entry\./i);
  assert.equal(source.includes(["000", "001"].join("")), false);
  assert.equal(fs.existsSync(path.join(siteDirectory, "annuaire.js")), false);
});
