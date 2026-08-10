
const API_URL = "https://suivi-agents-api.eddy-sapin.workers.dev";
let authLoaderPromise = null;

function ensureResponsibleAuth() {
  if (window.ResponsableAuth) return Promise.resolve(window.ResponsableAuth);
  if (authLoaderPromise) return authLoaderPromise;
  authLoaderPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "../auth.js";
    script.onload = () => window.ResponsableAuth ? resolve(window.ResponsableAuth) : reject(new Error("Authentification indisponible"));
    script.onerror = () => reject(new Error("Impossible de charger l’authentification"));
    document.head.appendChild(script);
  });
  return authLoaderPromise;
}

async function requireResponsibleSession() {
  const auth = await ensureResponsibleAuth();
  const user = await auth.require();
  if (!user) throw new Error("Authentification requise");
  return user;
}

async function apiGet(action, params = {}) {
  await requireResponsibleSession();
  const url = new URL(API_URL + "/");
  url.searchParams.set("action", action);
  for (const [k,v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }
  const r = await fetch(url.toString(), { method:"GET", cache:"no-store", credentials:"include" });
  const data = await r.json();
  if (!r.ok) throw new Error(data.message || data.code || "Erreur serveur");
  return data;
}

async function apiPost(action, payload) {
  const responsible = await requireResponsibleSession();
  const url = new URL(API_URL + "/");
  url.searchParams.set("action", action);
  const r = await fetch(url.toString(), {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    credentials:"include",
    body:JSON.stringify({...payload, action, id_responsable:responsible.id_responsable})
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.message || data.code || "Erreur serveur");
  return data;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
}

function setStatus(el, type, message) {
  el.className = "status show " + type;
  el.innerHTML = message;
}

function q(name) { return document.querySelector(name); }

function formObject(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function displayDate(iso) {
  if (!iso) return "—";
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}
