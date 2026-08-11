if (window.location.protocol !== "https:" && !/^(localhost|127\.0\.0\.1)$/i.test(window.location.hostname)) {
  const secureUrl = new URL(window.location.href);
  secureUrl.protocol = "https:";
  window.location.replace(secureUrl.toString());
}

const API_URL = "https://responsable-api.esapin.com";
const LOGIN_PATH = "/Nouvelle%20agent%20et%20suivi/connexion.html";
const AUTH_PAGE = /\/connexion\.html$/.test(window.location.pathname);
const authState = { user: null };

async function rawApi(action, { method = "GET", params = {}, payload = null } = {}) {
  const url = new URL(API_URL + "/");
  url.searchParams.set("action", action);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  const options = { method, credentials: "include", cache: "no-store", headers: { Accept: "application/json" } };
  if (method === "POST") { options.headers["Content-Type"] = "application/json"; options.body = JSON.stringify(payload || {}); }
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
function redirectToLogin(reason = "") { if (!AUTH_PAGE) window.location.replace(loginUrl(currentReturnPath(), reason)); }
function normalizedPath() { try { return decodeURIComponent(window.location.pathname); } catch (_) { return window.location.pathname; } }
function requiredAccessForPage() {
  const explicit = document.body && document.body.dataset ? document.body.dataset.requiredAccess : "";
  if (explicit) return explicit;
  const path = normalizedPath();
  if (/\/planning\.html$/.test(path)) return "planning";
  if (/\/contacts\.html$/.test(path)) return "contacts";
  if (/\/esprit-equipe\.html$/.test(path)) return "esprit_d_equipe";
  if (/\/nouveau-stagiaire\.html$/.test(path)) return "nouveau_stagiaire";
  if (path.includes("/Nouvelle agent et suivi/") && !/\/connexion\.html$/.test(path)) return "suivi_des_agents";
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
  installPortalHeader(user);
  installPortalNavigation(user);
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
  catch (error) { if (error.status === 401) redirectToLogin(); if (error.status === 403) window.location.replace("/?acces=refuse"); throw error; }
}
async function apiPost(action, payload = {}) {
  if (!AUTH_PAGE || !["login", "logout"].includes(action)) await GHE_AUTH_READY;
  try { return await rawApi(action, { method: "POST", payload }); }
  catch (error) { if (!AUTH_PAGE && error.status === 401) redirectToLogin(); if (!AUTH_PAGE && error.status === 403) window.location.replace("/?acces=refuse"); throw error; }
}
async function loginWithCode(code) { const data = await rawApi("login", { method: "POST", payload: { code } }); authState.user = data.user; return data.user; }
async function logout() { try { await rawApi("logout", { method: "POST", payload: {} }); } finally { authState.user = null; window.location.replace(loginUrl("/")); } }
async function existingSession() { if (AUTH_PAGE) return null; try { const data = await rawApi("session"); authState.user = data.user; return data.user; } catch (_) { return null; } }
function safeNextPath(value) {
  const next = String(value || "");
  if (!next.startsWith("/") || next.startsWith("//")) return "/";
  try { const url = new URL(next, window.location.origin); return url.origin === window.location.origin ? url.pathname + url.search + url.hash : "/"; } catch (_) { return "/"; }
}
function renderAuthControls(user) {
  const header = document.querySelector(".top, .topbar");
  if (!header || header.querySelector(".auth-controls")) return;
  const controls = document.createElement("div"); controls.className = "auth-controls";
  const identity = document.createElement("span"); identity.className = "auth-identity"; identity.textContent = user.display_name || `${user.prenom || ""} ${user.nom || ""}`.trim();
  const button = document.createElement("button"); button.type = "button"; button.className = "auth-logout"; button.textContent = "Déconnexion"; button.addEventListener("click", () => logout());
  controls.append(identity, button); header.appendChild(controls);
}

function portalModuleLabel(){
  const path=normalizedPath();
  if(/\/planning\.html$/.test(path))return "Planning";
  if(/\/contacts\.html$/.test(path))return "Contacts";
  if(/\/esprit-equipe\.html$/.test(path))return "Esprit d’équipe";
  if(/\/nouveau-stagiaire\.html$/.test(path))return "Nouveau stagiaire";
  if(path.includes("/Nouvelle agent et suivi/"))return "Suivi des agents";
  return "Mon espace";
}
function installPortalHeader(user){
  if(AUTH_PAGE||document.querySelector(".portal-topbar")||document.getElementById("ghePortalHeader"))return;
  const style=document.createElement("style");
  style.textContent=`.ghe-portal-header{position:sticky;top:0;z-index:9997;display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:58px;padding:8px 14px;background:rgba(255,255,255,.96);border-bottom:1px solid #dbe5ea;backdrop-filter:blur(14px);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif}.ghe-portal-header a{text-decoration:none;color:#102331;display:flex;align-items:center;gap:9px}.ghe-portal-header-mark{display:grid;place-items:center;width:36px;height:36px;border-radius:12px;background:linear-gradient(145deg,#102331,#1c607c);color:#fff;font-weight:900}.ghe-portal-header-copy strong{display:block;font-size:13px}.ghe-portal-header-copy small{display:block;margin-top:1px;color:#71838d;font-size:10px;font-weight:700}.ghe-portal-header-user{max-width:42vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#637782;font-size:11px;font-weight:800}@media(max-width:600px){.ghe-portal-header-user{display:none}}`;
  document.head.appendChild(style);
  const header=document.createElement("div"); header.id="ghePortalHeader"; header.className="ghe-portal-header";
  header.innerHTML=`<a href="/"><span class="ghe-portal-header-mark">G</span><span class="ghe-portal-header-copy"><strong>${portalModuleLabel()}</strong><small>GHE · Portail terrain</small></span></a><span class="ghe-portal-header-user">${esc(user.display_name||"")}</span>`;
  document.body.insertBefore(header,document.body.firstChild);
}
function portalMenuItems(user){
  return [
    ["/Nouvelle%20agent%20et%20suivi/","◎","Suivi des agents","suivi_des_agents"],
    ["https://sites.google.com/view/hfme-notes/notes-rapides","✎","Prendre des notes","prendre_des_notes",true],
    ["/planning.html","▦","Planning","planning"],
    ["/esprit-equipe.html","👥","Esprit d’équipe","esprit_d_equipe"],
    ["/contacts.html","☎","Contacts","contacts"],
    ["https://nouvel-agent.esapin.com/index.html","⌖","Nouvel arrivant","nouvel_arrivant",true],
    ["/nouveau-stagiaire.html","◇","Nouveau stagiaire","nouveau_stagiaire"]
  ].filter(item=>hasAccess(user,item[3]));
}
function installPortalNavigation(user) {
  if (AUTH_PAGE || document.getElementById("ghePortalDock")) return;
  const style = document.createElement("style");
  style.textContent = `.ghe-portal-dock{position:fixed;z-index:9999;left:50%;bottom:max(10px,env(safe-area-inset-bottom));transform:translateX(-50%);display:grid;grid-template-columns:repeat(3,1fr);gap:5px;width:min(310px,calc(100% - 28px));padding:7px;background:rgba(15,31,45,.94);backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,.16);border-radius:20px;box-shadow:0 14px 42px rgba(5,20,30,.25)}.ghe-portal-dock button,.ghe-portal-dock a{border:0;min-height:47px;padding:6px 9px;border-radius:14px;background:transparent;color:#fff;text-decoration:none;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;font:750 10px/1.05 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;cursor:pointer}.ghe-portal-dock .ico{font-size:18px}.ghe-portal-dock .home-link{background:#14a9d2}.ghe-menu-backdrop{position:fixed;inset:0;z-index:9998;background:rgba(5,18,27,.48);backdrop-filter:blur(4px);display:none}.ghe-menu-backdrop.open{display:block}.ghe-menu-sheet{position:absolute;left:50%;bottom:max(82px,calc(72px + env(safe-area-inset-bottom)));transform:translateX(-50%);width:min(520px,calc(100% - 28px));max-height:72vh;overflow:auto;padding:14px;background:#f7fafb;border:1px solid #cfdde3;border-radius:23px;box-shadow:0 24px 70px rgba(5,20,30,.3)}.ghe-menu-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:4px 3px 12px}.ghe-menu-head strong{font:900 18px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color:#102331}.ghe-menu-close{border:0;width:38px;height:38px;border-radius:12px;background:#e9f0f3;color:#102331;font-size:20px;font-weight:900}.ghe-menu-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.ghe-menu-list a{min-height:82px;padding:12px;border:1px solid #dbe5e9;border-radius:16px;background:#fff;color:#102331;text-decoration:none;display:flex;flex-direction:column;justify-content:center;gap:7px;font:850 13px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif}.ghe-menu-list a span{font-size:22px}@media(max-width:520px){.ghe-menu-list{grid-template-columns:1fr}.ghe-menu-sheet{max-height:68vh}}`;
  document.head.appendChild(style);
  const nav = document.createElement("nav"); nav.id = "ghePortalDock"; nav.className = "ghe-portal-dock"; nav.setAttribute("aria-label","Navigation principale");
  nav.innerHTML = `<button type="button" id="gheBack"><span class="ico">←</span><span>Retour</span></button><a href="/" class="home-link"><span class="ico">⌂</span><span>Accueil</span></a><button type="button" id="gheMenuOpen"><span class="ico">☰</span><span>Menu</span></button>`;
  const backdrop=document.createElement("div"); backdrop.id="gheMenuBackdrop"; backdrop.className="ghe-menu-backdrop";
  const items=portalMenuItems(user);
  backdrop.innerHTML=`<div class="ghe-menu-sheet" role="dialog" aria-modal="true" aria-label="Menu des rubriques"><div class="ghe-menu-head"><strong>Mes rubriques</strong><button type="button" class="ghe-menu-close" id="gheMenuClose" aria-label="Fermer">×</button></div><div class="ghe-menu-list">${items.map(x=>`<a href="${x[0]}"${x[4]?' target="_blank" rel="noopener"':''}><span>${x[1]}</span>${esc(x[2])}</a>`).join("")}</div></div>`;
  document.body.append(backdrop,nav);
  document.getElementById("gheBack").addEventListener("click",()=>{if(history.length>1)history.back();else location.href="/"});
  const open=()=>backdrop.classList.add("open"),close=()=>backdrop.classList.remove("open");
  document.getElementById("gheMenuOpen").addEventListener("click",open);
  document.getElementById("gheMenuClose").addEventListener("click",close);
  backdrop.addEventListener("click",e=>{if(e.target===backdrop)close()});
}

function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c])); }
function setStatus(el, type, message) { el.className = "status show " + type; el.innerHTML = message; }
function q(name) { return document.querySelector(name); }
function formObject(form) { return Object.fromEntries(new FormData(form).entries()); }
function displayDate(iso) { if (!iso) return "—"; const match = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/); return match ? `${match[3]}/${match[2]}/${match[1]}` : iso; }
window.GHEAuth = { ready: GHE_AUTH_READY, get user() { return authState.user; }, loginWithCode, existingSession, logout, safeNextPath, hasAccess: key => hasAccess(authState.user, key) };