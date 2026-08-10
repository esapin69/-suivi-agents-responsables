(() => {
  const API_URL = "https://suivi-agents-api.eddy-sapin.workers.dev";
  let currentUser = null;
  let resolveReady;
  const ready = new Promise(r => { resolveReady = r; });

  function styles() {
    if (document.getElementById("responsable-auth-style")) return;
    const s = document.createElement("style");
    s.id = "responsable-auth-style";
    s.textContent = `
      html.auth-locked body { overflow:hidden!important; }
      #responsable-auth-gate{position:fixed;inset:0;z-index:2147483647;background:#f3f7f9;display:flex;align-items:center;justify-content:center;padding:20px;font-family:Arial,sans-serif;color:#17232d}
      #responsable-auth-gate[hidden]{display:none!important}
      .auth-card{width:min(430px,100%);background:#fff;border:1px solid #dce7eb;border-radius:20px;padding:28px;box-shadow:0 24px 70px rgba(23,35,45,.16)}
      .auth-kicker{font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#54717d;margin-bottom:8px}.auth-card h1{margin:0 0 8px;font-size:28px}.auth-card p{margin:0 0 20px;color:#5b6d75;line-height:1.45}
      .auth-card label{display:block;font-weight:700;margin-bottom:8px}.auth-code{width:100%;box-sizing:border-box;font-size:28px;letter-spacing:.28em;text-align:center;padding:14px;border:1px solid #bdccd2;border-radius:12px;outline:none}.auth-code:focus{border-color:#1486a3;box-shadow:0 0 0 3px rgba(20,134,163,.12)}
      .auth-submit{width:100%;margin-top:14px;border:0;border-radius:12px;padding:14px 16px;font-size:16px;font-weight:800;background:#087f9c;color:#fff}.auth-submit:disabled{opacity:.55}.auth-error{min-height:22px;color:#a72222;margin-top:12px;font-size:14px}.auth-user-chip{position:fixed;right:12px;bottom:12px;z-index:9999;background:#17232d;color:#fff;border-radius:999px;padding:8px 12px;font:600 12px Arial,sans-serif;box-shadow:0 5px 20px rgba(0,0,0,.15)}.auth-user-chip button{border:0;background:transparent;color:#fff;text-decoration:underline;margin-left:8px;font:inherit;cursor:pointer}
    `;
    document.head.appendChild(s);
  }

  function gate() {
    styles();
    let root = document.getElementById("responsable-auth-gate");
    if (root) return root;
    root = document.createElement("div");
    root.id = "responsable-auth-gate";
    root.innerHTML = `<div class="auth-card"><div class="auth-kicker">Espace responsables · GHE</div><h1>Code d’accès</h1><p>Identifiez-vous avec votre code personnel à 6 chiffres.</p><form id="responsable-auth-form"><label for="responsable-auth-code">Votre code</label><input id="responsable-auth-code" class="auth-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required><button class="auth-submit" type="submit">Accéder à l’espace responsables</button><div id="responsable-auth-error" class="auth-error" role="alert"></div></form></div>`;
    document.body.appendChild(root);
    root.querySelector("form").addEventListener("submit", login);
    return root;
  }

  function lock() {
    document.documentElement.classList.add("auth-locked");
    gate().hidden = false;
    setTimeout(() => document.getElementById("responsable-auth-code")?.focus(), 0);
  }
  function unlock() {
    document.documentElement.classList.remove("auth-locked");
    const g = gate(); g.hidden = true;
    renderChip();
  }
  function renderChip() {
    document.getElementById("responsable-auth-chip")?.remove();
    if (!currentUser) return;
    const chip = document.createElement("div");
    chip.id = "responsable-auth-chip";
    chip.className = "auth-user-chip";
    chip.innerHTML = `${escapeHtml(currentUser.prenom || "")} ${escapeHtml(currentUser.nom || "")}<button type="button">Déconnexion</button>`;
    chip.querySelector("button").onclick = logout;
    document.body.appendChild(chip);
  }
  function escapeHtml(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));}

  async function request(path, options={}) {
    const r = await fetch(API_URL + path, { credentials:"include", cache:"no-store", ...options });
    let data = {};
    try { data = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error(data.message || data.code || "Accès refusé");
    return data;
  }
  async function check() {
    lock();
    try {
      const d = await request("/auth/me");
      currentUser = d.user || null;
      if (currentUser) unlock();
    } catch (_) { currentUser = null; }
    resolveReady(currentUser);
  }
  async function login(e) {
    e.preventDefault();
    const input = document.getElementById("responsable-auth-code");
    const error = document.getElementById("responsable-auth-error");
    const button = e.currentTarget.querySelector("button");
    const code = input.value.replace(/\D/g, "");
    if (code.length !== 6) { error.textContent = "Le code doit contenir 6 chiffres."; return; }
    button.disabled = true; error.textContent = "";
    try {
      const d = await request("/auth/login", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({code}) });
      currentUser = d.user;
      input.value = "";
      unlock();
      window.dispatchEvent(new CustomEvent("responsable-authenticated", {detail:{user:currentUser}}));
    } catch (err) { error.textContent = err.message || "Code incorrect."; }
    finally { button.disabled = false; }
  }
  async function logout() {
    try { await request("/auth/logout", {method:"POST"}); } catch (_) {}
    currentUser = null;
    document.getElementById("responsable-auth-chip")?.remove();
    lock();
  }

  window.ResponsableAuth = { ready, get user(){ return currentUser; }, require: () => ready };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", check, {once:true}); else check();
})();