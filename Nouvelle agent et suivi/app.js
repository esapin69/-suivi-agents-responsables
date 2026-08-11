const API_URL = "https://responsable-api.esapin.com";
const LOGIN_PATH = "/Nouvelle%20agent%20et%20suivi/connexion.html";
const AUTH_PAGE = /\/connexion\.html$/.test(window.location.pathname);

const authState = { user: null };

async function rawApi(action, { method = "GET", params = {}, payload = null } = {}) {
  const url = new URL(API_URL + "/");
  url.searchParams.set("action", action);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }
  const options = { method, credentials: "include", cache: "no-store", headers: { Accept: "application/json" } };
  if (method === "POST") {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(payload || {});
  }
  let response;
  try { response = await fetch(url.toString(), options); }
  catch (_) { throw new Error("Connexion au service impossible. Vérifiez le réseau puis réessayez."); }
  let data;
  try { data = await response.json(); }
  catch (_) { throw new Error("Le service a renvoyé une réponse illisible."); }
  if (!response.ok) {
    const error = new Error(data.message || data.code || "Erreur serveur");
    error.code = data.code || "ERREUR_SERVEUR";
    error.status = response.status;
    throw error;
  }
  return data;
}

function currentReturnPath() { return window.location.pathname + window.location.search + window.location.hash; }

function loginUrl(next = currentReturnPath(), reason = "") {
  const url = new URL(LOGIN_PATH, window.location.origin);
  if (next && next !== LOGIN_PATH) url.searchParams.set("next", next);
  if (reason) url.searchParams.set("erreur", reason);
  return url.toString();
}

function redirectToLogin(reason = "") {
  if (AUTH_PAGE) return;
  window.location.replace(loginUrl(currentReturnPath(), reason));
}

function normalizedPath() {
  try { return decodeURIComponent(window.location.pathname); }
  catch (_) { return window.location.pathname; }
}

function requiredAccessForPage() {
  const explicit = document.body && document.body.dataset ? document.body.dataset.requiredAccess : "";
  if (explicit) return explicit;
  const path = normalizedPath();
  if (path.includes("/Nouvelle agent et suivi/") && !/\/connexion\.html$/.test(path)) return "suivi_des_agents";
  if (/\/nouveau-stagiaire\.html$/.test(path)) return "nouveau_stagiaire";
  return "";
}

function hasAccess(user, key) { return Boolean(user && user.access && user.access[key] === true); }

function enforcePageAccess(user) {
  const required = requiredAccessForPage();
  if (!required || hasAccess(user, required)) return true;
  window.location.replace("/?acces=refuse");
  return false;
}

function renderAccessControlledElements(user) {
  document.querySelectorAll("[data-access]").forEach(el => {
    const key = String(el.dataset.access || "").trim();
    el.hidden = !key || !hasAccess(user, key);
  });
}

function showAuthenticatedPage(user) {
  authState.user = user;
  if (!enforcePageAccess(user)) return user;
  renderAccessControlledElements(user);
  document.documentElement.classList.remove("auth-pending");
  document.documentElement.classList.add("auth-ready");
  renderAuthControls(user);
  document.dispatchEvent(new CustomEvent("ghe-authenticated", { detail: user }));
  return user;
}

async function loadSession() {
  try { return showAuthenticatedPage((await rawApi("session")).user); }
  catch (error) {
    if (error.status === 401 || error.status === 403) { redirectToLogin(); return new Promise(() => {}); }
    redirectToLogin("service");
    return new Promise(() => {});
  }
}

const GHE_AUTH_READY = AUTH_PAGE ? Promise.resolve(null) : loadSession();

async function apiGet(action, params = {}) {
  await GHE_AUTH_READY;
  try { return await rawApi(action, { params }); }
  catch (error) {
    if (error.status === 401) redirectToLogin();
    if (error.status === 403) window.location.replace("/?acces=refuse");
    throw error;
  }
}

async function apiPost(action, payload = {}) {
  if (!AUTH_PAGE || !["login", "logout"].includes(action)) await GHE_AUTH_READY;
  try { return await rawApi(action, { method: "POST", payload }); }
  catch (error) {
    if (!AUTH_PAGE && error.status === 401) redirectToLogin();
    if (!AUTH_PAGE && error.status === 403) window.location.replace("/?acces=refuse");
    throw error;
  }
}

async function loginWithCode(code) {
  const data = await rawApi("login", { method: "POST", payload: { code } });
  authState.user = data.user;
  return data.user;
}

async function logout() {
  try { await rawApi("logout", { method: "POST", payload: {} }); }
  finally { authState.user = null; window.location.replace(loginUrl("/")); }
}

async function existingSession() {
  try { const data = await rawApi("session"); authState.user = data.user; return data.user; }
  catch (_) { return null; }
}

function safeNextPath(value) {
  const next = String(value || "");
  if (!next.startsWith("/") || next.startsWith("//")) return "/";
  try {
    const url = new URL(next, window.location.origin);
    return url.origin === window.location.origin ? url.pathname + url.search + url.hash : "/";
  } catch (_) { return "/"; }
}

function renderAuthControls(user) {
  const header = document.querySelector(".top, .topbar");
  if (!header || header.querySelector(".auth-controls")) return;
  const controls = document.createElement("div");
  controls.className = "auth-controls";
  const identity = document.createElement("span");
  identity.className = "auth-identity";
  identity.textContent = user.display_name || `${user.prenom || ""} ${user.nom || ""}`.trim();
  const button = document.createElement("button");
  button.type = "button";
  button.className = "auth-logout";
  button.textContent = "Déconnexion";
  button.addEventListener("click", () => logout());
  controls.append(identity, button);
  header.appendChild(controls);
}

function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c])); }
function setStatus(el, type, message) { el.className = "status show " + type; el.innerHTML = message; }
function q(name) { return document.querySelector(name); }
function formObject(form) { return Object.fromEntries(new FormData(form).entries()); }
function displayDate(iso) {
  if (!iso) return "—";
  const match = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : iso;
}

window.GHEAuth = {
  ready: GHE_AUTH_READY,
  get user() { return authState.user; },
  loginWithCode,
  existingSession,
  logout,
  safeNextPath,
  hasAccess: key => hasAccess(authState.user, key),
};