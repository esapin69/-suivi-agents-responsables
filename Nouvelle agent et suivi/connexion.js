const form = document.getElementById("loginForm");
const codeInput = document.getElementById("accessCode");
const status = document.getElementById("loginStatus");
const button = document.getElementById("loginButton");
const toggle = document.getElementById("toggleCode");
const loginParams = new URL(window.location.href).searchParams;
const next = GHEAuth.safeNextPath(loginParams.get("next"));

if (loginParams.get("erreur") === "service") {
  setStatus(status, "err", "Le service était momentanément inaccessible. Vous pouvez réessayer ici.");
}

toggle.addEventListener("click", () => {
  const visible = codeInput.type === "text";
  codeInput.type = visible ? "password" : "text";
  toggle.textContent = visible ? "Afficher" : "Masquer";
  toggle.setAttribute("aria-pressed", String(!visible));
  toggle.setAttribute("aria-label", visible ? "Afficher le code" : "Masquer le code");
  codeInput.focus();
});

codeInput.addEventListener("input", () => {
  codeInput.value = codeInput.value.replace(/\D/g, "").slice(0, 6);
  status.className = "status";
  status.textContent = "";
});

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  button.disabled = true;
  button.textContent = "Vérification…";
  setStatus(status, "warn", "Vérification du code…");
  try {
    await GHEAuth.loginWithCode(codeInput.value);
    setStatus(status, "ok", "✓ Accès autorisé.");
    window.location.replace(next);
  } catch (error) {
    codeInput.select();
    setStatus(status, "err", esc(error.message));
  } finally {
    button.disabled = false;
    button.textContent = "Se connecter";
  }
});