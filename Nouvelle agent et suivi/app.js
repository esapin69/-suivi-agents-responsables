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
    if (!key || !hasAccess(user, key)) el.hidden = true;
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
  installGestionContext(user);
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
  style.textContent = `.ghe-portal-dock{position:fixed;z-index:9999;left:50%;bottom:max(10px,env(safe-area-inset-bottom));transform:translateX(-50%);display:grid;grid-template-columns:repeat(3,1fr);gap:5px;width:min(310px,calc(100% - 28px));padding:7px;background:rgba(15,31,45,.94);backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,.16);border-radius:20px;box-shadow:0 14px 42px rgba(5,20,30,.25)}.ghe-portal-dock button,.ghe-portal-dock a{border:0;min-height:47px;padding:6px 9px;border-radius:14px;background:transparent;color:#fff;text-decoration:none;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;font:750 10px/1.05 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;cursor:pointer}.ghe-portal-dock .ico{font-size:18px}.ghe-portal-dock .home-link{background:#14a9d2}.ghe-menu-backdrop{position:fixed;inset:0;z-index:9998;background:rgba(5,18,27,.48);backdrop-filter:blur(4px);display:none}.ghe-menu-backdrop.open{display:block}.ghe-menu-sheet{position:absolute;left:50%;bottom:max(82px,calc(72px + env(safe-area-inset-bottom)));transform:translateX(-50%);width:min(520px,calc(100% - 28px));max-height:72vh;overflow:auto;padding:14px;background:#f7fafb;border:1px solid #cfdde3;border-radius:23px;box-shadow:0 24px 70px rgba(5,20,30,.3)}.ghe-menu-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:4px 3px 12px}.ghe-menu-head strong{font:900 18px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color:#102331}.ghe-menu-close{border:0;width:auto;min-width:72px;height:38px;padding:0 12px;border-radius:12px;background:#e9f0f3;color:#102331;font-size:12px;font-weight:900}.ghe-menu-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.ghe-menu-list a{min-height:82px;padding:12px;border:1px solid #dbe5e9;border-radius:16px;background:#fff;color:#102331;text-decoration:none;display:flex;flex-direction:column;justify-content:center;gap:7px;font:850 13px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif}.ghe-menu-list a span{font-size:22px}@media(max-width:520px){.ghe-menu-list{grid-template-columns:1fr}.ghe-menu-sheet{max-height:68vh}}`;
  document.head.appendChild(style);
  const nav = document.createElement("nav"); nav.id = "ghePortalDock"; nav.className = "ghe-portal-dock"; nav.setAttribute("aria-label","Navigation principale");
  nav.innerHTML = `<button type="button" id="gheBack"><span class="ico">←</span><span>Retour</span></button><a href="/" class="home-link"><span class="ico">⌂</span><span>Accueil</span></a><button type="button" id="gheMenuOpen"><span class="ico">☰</span><span>Menu</span></button>`;
  const backdrop=document.createElement("div"); backdrop.id="gheMenuBackdrop"; backdrop.className="ghe-menu-backdrop";
  const items=portalMenuItems(user);
  backdrop.innerHTML=`<div class="ghe-menu-sheet" role="dialog" aria-modal="true" aria-label="Menu des rubriques"><div class="ghe-menu-head"><strong>Mes rubriques</strong><button type="button" class="ghe-menu-close" id="gheMenuClose">Fermer</button></div><div class="ghe-menu-list">${items.map(x=>`<a href="${x[0]}"${x[4]?' target="_blank" rel="noopener"':''}><span>${x[1]}</span>${esc(x[2])}</a>`).join("")}</div></div>`;
  document.body.append(backdrop,nav);
  document.getElementById("gheBack").addEventListener("click",()=>{if(history.length>1)history.back();else location.href="/"});
  const open=()=>backdrop.classList.add("open"),close=()=>backdrop.classList.remove("open");
  document.getElementById("gheMenuOpen").addEventListener("click",open);
  document.getElementById("gheMenuClose").addEventListener("click",close);
  backdrop.addEventListener("click",e=>{if(e.target===backdrop)close()});
}

function installGestionContext(user){
  if(AUTH_PAGE || !hasAccess(user,"gestion") || document.getElementById("gheGestionStyle")) return;
  document.documentElement.classList.add("gestion-mode");
  const style=document.createElement("style");
  style.id="gheGestionStyle";
  style.textContent=`
    .gestion-mode #manageBtn,.gestion-mode #manage{display:none!important}
    .ghe-managed-wrap{position:relative;display:flex;align-items:stretch;gap:7px;width:100%}
    .ghe-managed-wrap>.agent,.ghe-managed-wrap>.evaluation-row,.ghe-managed-wrap>.portal-card,.ghe-managed-wrap>.workspace-block,.ghe-managed-wrap>.stage-link{flex:1;min-width:0}
    .ghe-context-btn{flex:0 0 42px;width:42px;min-width:42px;border:1px solid #cbd9df;border-radius:12px;background:#fff;color:#17313f;font-size:24px;line-height:1;font-weight:900;cursor:pointer;box-shadow:0 4px 14px rgba(13,36,48,.06)}
    .ghe-context-btn:hover,.ghe-context-btn:focus-visible{border-color:#14add3;outline:3px solid rgba(20,173,211,.15)}
    .contact-item{position:relative}.contact-item>.ghe-context-btn{position:absolute;right:10px;top:10px;height:38px;width:38px;min-width:38px;font-size:21px}.contact-item.ghe-has-context{padding-right:58px!important}
    .agent-head .ghe-inline-admin{display:flex;gap:7px;align-items:center}.agent-head .ghe-inline-admin .ghe-context-btn{height:42px}
    .ghe-admin-pencil{width:42px;height:42px;border:1px solid #b9d4df;border-radius:12px;background:#e9f8fc;color:#087f9f;font-size:18px;font-weight:900;cursor:pointer}
    .ghe-context-backdrop{position:fixed;inset:0;z-index:10020;background:rgba(5,18,27,.38);backdrop-filter:blur(3px);display:grid;align-items:end;justify-items:center;padding:18px 14px max(92px,calc(82px + env(safe-area-inset-bottom)))}
    .ghe-context-sheet{width:min(540px,100%);max-height:70vh;overflow:auto;background:#f8fbfc;border:1px solid #cfdee4;border-radius:22px;padding:14px;box-shadow:0 26px 70px rgba(5,20,30,.32)}
    .ghe-context-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:4px 3px 12px}.ghe-context-head strong{font-size:17px;color:#102331}.ghe-context-close{border:0;border-radius:11px;background:#e8f0f3;color:#102331;padding:10px 13px;font-size:12px;font-weight:900;cursor:pointer}
    .ghe-context-actions{display:grid;gap:8px}.ghe-context-action{width:100%;border:1px solid #d7e3e8;border-radius:14px;background:#fff;color:#17232d;min-height:54px;padding:12px 14px;text-align:left;font-size:14px;font-weight:850;cursor:pointer;display:flex;align-items:center;gap:12px}.ghe-context-action span{font-size:20px;width:26px;text-align:center}.ghe-context-action small{display:block;color:#687984;font-weight:650;margin-top:2px}.ghe-context-action.danger{color:#9a2f2f;border-color:#efc7c7;background:#fff8f8}
    .ghe-toast{position:fixed;z-index:10030;left:50%;bottom:max(92px,calc(82px + env(safe-area-inset-bottom)));transform:translateX(-50%);max-width:calc(100% - 28px);background:#102331;color:#fff;padding:11px 15px;border-radius:12px;font-size:13px;font-weight:800;box-shadow:0 10px 30px rgba(0,0,0,.24)}
  `;
  document.head.appendChild(style);

  const toast=message=>{
    document.querySelector(".ghe-toast")?.remove();
    const n=document.createElement("div");n.className="ghe-toast";n.textContent=message;document.body.appendChild(n);setTimeout(()=>n.remove(),1800);
  };
  const copy=async value=>{
    const text=String(value||"").trim();if(!text)return;
    try{await navigator.clipboard.writeText(text);toast("Copié");}
    catch(_){const ta=document.createElement("textarea");ta.value=text;ta.style.position="fixed";ta.style.opacity="0";document.body.appendChild(ta);ta.select();document.execCommand("copy");ta.remove();toast("Copié");}
  };
  const openSheet=(title,actions)=>{
    document.querySelector(".ghe-context-backdrop")?.remove();
    const back=document.createElement("div");back.className="ghe-context-backdrop";
    const sheet=document.createElement("div");sheet.className="ghe-context-sheet";sheet.setAttribute("role","dialog");sheet.setAttribute("aria-modal","true");
    const head=document.createElement("div");head.className="ghe-context-head";head.innerHTML=`<strong>${esc(title||"Options")}</strong>`;
    const close=document.createElement("button");close.type="button";close.className="ghe-context-close";close.textContent="Fermer";head.appendChild(close);
    const list=document.createElement("div");list.className="ghe-context-actions";
    actions.filter(Boolean).forEach(action=>{
      const b=document.createElement("button");b.type="button";b.className="ghe-context-action"+(action.danger?" danger":"");
      b.innerHTML=`<span>${esc(action.icon||"›")}</span><div>${esc(action.label)}${action.hint?`<small>${esc(action.hint)}</small>`:""}</div>`;
      b.addEventListener("click",async()=>{if(action.keepOpen!==true)back.remove();await action.run?.();});list.appendChild(b);
    });
    sheet.append(head,list);back.appendChild(sheet);document.body.appendChild(back);
    close.onclick=()=>back.remove();back.addEventListener("click",e=>{if(e.target===back)back.remove()});
  };
  const wrapWithMenu=(target,title,actionsFactory)=>{
    if(!target || target.dataset.gheManaged==="1")return;
    target.dataset.gheManaged="1";
    const parent=target.parentNode;if(!parent)return;
    const wrap=document.createElement("div");wrap.className="ghe-managed-wrap";parent.insertBefore(wrap,target);wrap.appendChild(target);
    const b=document.createElement("button");b.type="button";b.className="ghe-context-btn";b.setAttribute("aria-label","Options de gestion");b.textContent="⋯";
    b.addEventListener("click",e=>{e.preventDefault();e.stopPropagation();openSheet(typeof title==="function"?title():title,actionsFactory())});wrap.appendChild(b);
  };
  const linkActions=link=>[
    {icon:"↗",label:"Ouvrir",run:()=>{location.href=link.href}},
    {icon:"⧉",label:"Copier le lien",run:()=>copy(link.href)}
  ];

  function decorate(){
    document.querySelectorAll("a.agent:not([data-ghe-managed])").forEach(link=>{
      let u;try{u=new URL(link.href)}catch(_){return}
      const id=u.searchParams.get("id")||"";
      const name=link.querySelector("strong")?.textContent?.trim()||"Agent";
      wrapWithMenu(link,name,()=>[
        {icon:"↗",label:"Ouvrir la fiche",run:()=>{location.href=link.href}},
        {icon:"✎",label:"Modifier les informations",hint:"Nom, téléphone, matricule, arrivée…",run:()=>{const x=new URL(link.href);x.searchParams.set("edit","1");location.href=x.toString()}},
        {icon:"⧉",label:"Copier l’identifiant",run:()=>copy(id)},
        {icon:"🔗",label:"Copier le lien de la fiche",run:()=>copy(link.href)}
      ]);
    });

    document.querySelectorAll(".evaluation-row:not([data-ghe-managed])").forEach(row=>{
      const evId=row.dataset.id||"";const label=row.querySelector("strong")?.textContent?.trim()||"Évaluation";const badge=row.querySelector(".badge")?.textContent||"";
      wrapWithMenu(row,label,()=>[
        {icon:"↗",label:badge.includes("Brouillon")?"Ouvrir et modifier":"Ouvrir l’évaluation",run:()=>row.click()},
        {icon:"⧉",label:"Copier l’identifiant",run:()=>copy(evId)},
        badge.includes("Officiel")?{icon:"＋",label:"Préparer une nouvelle version",hint:"L’original reste intact",run:()=>{row.click();setTimeout(()=>document.getElementById("newVersionBtn")?.click(),350)}}:null
      ]);
    });

    document.querySelectorAll(".contact-item:not([data-ghe-managed])").forEach(card=>{
      card.dataset.gheManaged="1";card.classList.add("ghe-has-context");
      const title=card.querySelector("strong")?.textContent?.trim()||"Contact";
      const links=[...card.querySelectorAll("a")];const phone=links.find(a=>a.href.startsWith("tel:"));const mails=links.filter(a=>a.href.startsWith("mailto:"));
      const b=document.createElement("button");b.type="button";b.className="ghe-context-btn";b.textContent="⋯";b.setAttribute("aria-label","Options du contact");
      b.onclick=e=>{e.preventDefault();e.stopPropagation();openSheet(title,[
        phone?{icon:"☎",label:"Appeler",run:()=>{location.href=phone.href}}:null,
        phone?{icon:"⧉",label:"Copier le numéro",run:()=>copy(phone.href.replace(/^tel:/,""))}:null,
        mails[0]?{icon:"✉",label:"Écrire un e-mail",run:()=>{location.href=mails[0].href}}:null,
        mails[0]?{icon:"⧉",label:"Copier l’e-mail",run:()=>copy(mails[0].href.replace(/^mailto:/,""))}:null
      ])};card.appendChild(b);
    });

    document.querySelectorAll("a.portal-card:not([data-ghe-managed]),a.workspace-block:not([data-ghe-managed]),a.stage-link:not([data-ghe-managed])").forEach(link=>{
      const title=link.querySelector("h2,h3,strong")?.textContent?.trim()||"Raccourci";
      wrapWithMenu(link,title,()=>linkActions(link));
    });

    const head=document.querySelector(".agent-head");
    if(head && !head.querySelector(".ghe-inline-admin")){
      const old=head.querySelector("#manageBtn");
      const tools=document.createElement("div");tools.className="ghe-inline-admin";
      const edit=document.createElement("button");edit.type="button";edit.className="ghe-admin-pencil";edit.textContent="✎";edit.setAttribute("aria-label","Modifier la fiche");
      edit.onclick=()=>document.getElementById("manageEditBtn")?.click();
      const more=document.createElement("button");more.type="button";more.className="ghe-context-btn";more.textContent="⋯";more.setAttribute("aria-label","Plus d’options");
      more.onclick=()=>{
        const agentName=document.getElementById("name")?.textContent?.trim()||"Agent";
        const file=document.getElementById("fileBtn");const currentId=new URL(location.href).searchParams.get("id")||"";
        openSheet(agentName,[
          {icon:"✎",label:"Modifier les informations",run:()=>document.getElementById("manageEditBtn")?.click()},
          {icon:"↻",label:"Actualiser depuis la source",run:()=>document.getElementById("manageRefreshBtn")?.click()},
          {icon:"⧉",label:"Copier l’identifiant",run:()=>copy(currentId)},
          file&&!file.hidden&&file.href&&file.href!==location.href+"#"?{icon:"▣",label:"Ouvrir le fichier brouillon",run:()=>window.open(file.href,"_blank","noopener")}:null,
          {icon:"🔗",label:"Copier le lien de cette fiche",run:()=>copy(location.href)}
        ]);
      };
      tools.append(edit,more);old?.before(tools);
    }

    const params=new URL(location.href).searchParams;
    if(/\/agent\.html$/.test(normalizedPath())&&params.get("edit")==="1"&&!document.body.dataset.gheAutoEdit){
      document.body.dataset.gheAutoEdit="1";setTimeout(()=>document.getElementById("manageEditBtn")?.click(),700);
    }
  }
  decorate();
  const observer=new MutationObserver(()=>decorate());observer.observe(document.body,{childList:true,subtree:true});
  window.GHEGestion={openSheet,copy,decorate};
}

function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c])); }
function setStatus(el, type, message) { el.className = "status show " + type; el.innerHTML = message; }
function q(name) { return document.querySelector(name); }
function formObject(form) { return Object.fromEntries(new FormData(form).entries()); }
function displayDate(iso) { if (!iso) return "—"; const match = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/); return match ? `${match[3]}/${match[2]}/${match[1]}` : iso; }
window.GHEAuth = { ready: GHE_AUTH_READY, get user() { return authState.user; }, loginWithCode, existingSession, logout, safeNextPath, hasAccess: key => hasAccess(authState.user, key) };