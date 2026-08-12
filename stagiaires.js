(() => {
  "use strict";

  const localDevelopment = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const API = localDevelopment ? location.origin : "https://responsable-api.esapin.com";
  const page = document.body?.dataset.stagiairePage;
  const state = { user: null, mode: "", traineeId: "", record: null, directory: [], status: "OPEN", query: "", signatureAction: null, drawing: false, drawn: false };
  const ratingFields = [
    ["autonomy", "Autonomie"],
    ["techniqueHandling", "Technique et manutention"],
    ["safetyHygiene", "Sécurité et hygiène"],
    ["communication", "Communication"],
    ["organization", "Organisation"],
    ["professionalBehavior", "Comportement professionnel"],
  ];

  async function api(path, { method = "GET", body } = {}) {
    const options = { method, credentials: "include", cache: "no-store", headers: { Accept: "application/json" } };
    if (body !== undefined) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    let response;
    try { response = await fetch(API + path, options); }
    catch { throw friendlyError("Connexion au service impossible. Vérifiez le réseau puis réessayez."); }
    let data = {};
    try { data = await response.json(); } catch { data = {}; }
    if (!response.ok) {
      const error = friendlyError(data.message || "La demande n’a pas pu être traitée.");
      error.status = response.status;
      error.code = data.code || "ERREUR";
      error.details = data.details;
      throw error;
    }
    return data;
  }

  function friendlyError(message) { return Object.assign(new Error(message), { friendly: true }); }
  function byId(id) { return document.getElementById(id); }
  function esc(value) { return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]); }
  function formatDate(value) { const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/); return match ? `${match[3]}/${match[2]}/${match[1]}` : value || "—"; }
  function formatDateTime(value) { try { return new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)); } catch { return value || "—"; } }
  function formData(form) { return Object.fromEntries(new FormData(form).entries()); }
  function showNotice(element, message, type = "") { if (!element) return; element.hidden = false; element.className = `notice${type ? ` ${type}` : ""}`; element.textContent = message; element.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
  function clearNotice(element) { if (element) element.hidden = true; }
  function pending(button, active, label = "Enregistrement…") { if (!button) return; if (active) { button.dataset.label = button.textContent; button.textContent = label; button.disabled = true; } else { button.textContent = button.dataset.label || button.textContent; button.disabled = false; } }
  function isManager() { return state.user && ["ADMIN", "CHEF"].includes(state.user.role); }
  function isAdmin() { return state.user && state.user.role === "ADMIN"; }
  function isTutor() { return state.user && state.record?.trainee?.tutorUserId === state.user.id; }

  async function bootDashboard() {
    try {
      state.user = await window.GHEAuth.ready;
      bindDashboard();
      await loadDirectory();
      if (isAdmin()) {
        byId("adminPanel").hidden = false;
        await loadUsers();
      }
      await loadTrainees();
    } catch (error) { showNotice(byId("dashboardNotice"), error.message, "error"); }
  }

  function bindDashboard() {
    const createPanel = byId("createPanel");
    const createForm = byId("createTraineeForm");
    const openCreate = () => { createPanel.hidden = false; createPanel.scrollIntoView({ behavior: "smooth" }); createForm.elements.firstName.focus(); };
    const closeCreate = () => { createPanel.hidden = true; createForm.reset(); };
    byId("showCreate").addEventListener("click", openCreate);
    byId("hideCreate").addEventListener("click", closeCreate);
    byId("cancelCreate").addEventListener("click", closeCreate);
    createForm.addEventListener("submit", createTrainee);
    let searchTimer;
    byId("traineeSearch").addEventListener("input", event => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.query = event.target.value.trim(); loadTrainees(); }, 250);
    });
    byId("statusFilters").addEventListener("click", event => {
      const button = event.target.closest("button[data-status]");
      if (!button) return;
      byId("statusFilters").querySelectorAll("button").forEach(item => item.classList.toggle("active", item === button));
      state.status = button.dataset.status;
      loadTrainees();
    });
    byId("toggleUserForm")?.addEventListener("click", () => { byId("createUserForm").hidden = !byId("createUserForm").hidden; });
    byId("createUserForm")?.addEventListener("submit", createUser);
    byId("userList")?.addEventListener("click", updateUserFromRow);
  }

  async function loadTrainees() {
    const list = byId("traineeList");
    list.innerHTML = '<div class="loading-card">Chargement des fiches…</div>';
    const params = new URLSearchParams();
    if (state.status) params.set("status", state.status);
    if (state.query) params.set("q", state.query);
    try {
      const data = await api(`/v2/trainees?${params}`);
      if (!data.trainees.length) {
        list.innerHTML = '<div class="empty-card">Aucune fiche ne correspond à cette recherche.</div>';
        return;
      }
      list.innerHTML = data.trainees.map(trainee => `
        <a class="trainee-card" href="/fiche-stagiaire.html?id=${encodeURIComponent(trainee.id)}">
          <div><span class="trainee-ref">${esc(trainee.reference)}</span><h2>${esc(trainee.displayName)}</h2><p>${esc(trainee.school || "Établissement non renseigné")}<br>${formatDate(trainee.startDate)} au ${formatDate(trainee.endDate)} · version ${trainee.recordVersion}</p></div>
          <span class="status-pill${trainee.status === "CLOSED" ? " closed" : ""}">${trainee.status === "CLOSED" ? "Clôturée" : "En cours"}</span>
        </a>`).join("");
    } catch (error) { list.innerHTML = `<div class="empty-card">${esc(error.message)}</div>`; }
  }

  async function loadDirectory() {
    const data = await api("/v2/directory");
    state.directory = data.users;
    const select = byId("tutorUserId");
    select.innerHTML = '<option value="">À définir plus tard</option>' + data.users.map(user => `<option value="${esc(user.id)}">${esc(user.displayName)}${user.position ? ` · ${esc(user.position)}` : ""}</option>`).join("");
  }

  async function createTrainee(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button[type=submit]");
    pending(button, true, "Création…");
    clearNotice(byId("dashboardNotice"));
    try {
      const values = formData(form);
      if (values.tutorUserId && !values.tutorName) values.tutorName = state.directory.find(user => user.id === values.tutorUserId)?.displayName || "";
      const data = await api("/v2/trainees", { method: "POST", body: values });
      location.href = `/fiche-stagiaire.html?id=${encodeURIComponent(data.record.trainee.id)}`;
    } catch (error) { showNotice(byId("dashboardNotice"), error.message, "error"); pending(button, false); }
  }

  async function loadUsers() {
    const list = byId("userList");
    list.innerHTML = '<div class="loading-card">Chargement des accès…</div>';
    try {
      const data = await api("/v2/admin/users");
      list.innerHTML = data.users.map(user => `
        <div class="user-row" data-user-id="${esc(user.id)}">
          <div><strong>${esc(user.displayName)}</strong><small>${esc(user.position || "Fonction non renseignée")}</small></div>
          <label>Rôle<select data-field="role"><option value="AGENT"${user.role === "AGENT" ? " selected" : ""}>Agent</option><option value="CHEF"${user.role === "CHEF" ? " selected" : ""}>Chef</option><option value="ADMIN"${user.role === "ADMIN" ? " selected" : ""}>Admin</option></select></label>
          <label>Actif<select data-field="active"><option value="true"${user.active ? " selected" : ""}>Oui</option><option value="false"${!user.active ? " selected" : ""}>Non</option></select></label>
          <label>Nouveau code<input data-field="pin" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" placeholder="Laisser inchangé"></label>
          <button class="mini-button" type="button" data-save-user>Enregistrer</button>
        </div>`).join("");
    } catch (error) { list.innerHTML = `<div class="empty-card">${esc(error.message)}</div>`; }
  }

  async function createUser(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button[type=submit]");
    pending(button, true);
    try {
      await api("/v2/admin/users", { method: "POST", body: formData(form) });
      form.reset(); form.hidden = true;
      showNotice(byId("dashboardNotice"), "L’accès a été créé. Le code n’est pas affiché et doit être transmis directement à la personne.", "success");
      await loadUsers();
    } catch (error) { showNotice(byId("dashboardNotice"), error.message, "error"); }
    finally { pending(button, false); }
  }

  async function updateUserFromRow(event) {
    const button = event.target.closest("[data-save-user]");
    if (!button) return;
    const row = button.closest("[data-user-id]");
    const pin = row.querySelector('[data-field="pin"]').value.trim();
    const body = {
      role: row.querySelector('[data-field="role"]').value,
      active: row.querySelector('[data-field="active"]').value === "true",
      ...(pin ? { pin } : {}),
    };
    pending(button, true);
    try {
      await api(`/v2/admin/users/${encodeURIComponent(row.dataset.userId)}`, { method: "PATCH", body });
      showNotice(byId("dashboardNotice"), "L’accès a été mis à jour. Les anciennes sessions de cette personne sont maintenant invalidées.", "success");
      await loadUsers();
    } catch (error) { showNotice(byId("dashboardNotice"), error.message, "error"); pending(button, false); }
  }

  async function bootRecord() {
    bindRecord();
    const params = new URLSearchParams(location.search);
    const sharedToken = params.get("token");
    try {
      if (sharedToken) {
        const exchanged = await api("/v2/share/exchange", { method: "POST", body: { token: sharedToken } });
        state.mode = "trainee";
        state.traineeId = exchanged.traineeId;
        history.replaceState({}, "", `/fiche-stagiaire.html?id=${encodeURIComponent(state.traineeId)}`);
      } else {
        state.traineeId = params.get("id") || "";
        try {
          const session = await api("/v2/auth/session");
          state.mode = "user";
          state.user = session.user;
        } catch (error) {
          if (error.status !== 401) throw error;
          state.mode = "trainee";
        }
      }
      if (!state.traineeId) throw friendlyError("Adresse de fiche incomplète.");
      if (state.mode === "trainee") { byId("recordBack").hidden = true; }
      await refreshRecord();
    } catch (error) {
      byId("recordIntro").innerHTML = `<h1>Accès impossible</h1><p>${esc(error.message)}</p>`;
      showNotice(byId("recordNotice"), error.message, "error");
    }
  }

  function bindRecord() {
    buildRatingGrid();
    byId("observationForm").elements.observedOn.value = new Date().toISOString().slice(0, 10);
    byId("observationForm").addEventListener("submit", saveObservation);
    byId("cancelObservationEdit").addEventListener("click", resetObservationForm);
    byId("observationList").addEventListener("click", observationAction);
    byId("selfSectionForm").addEventListener("submit", saveSelfSection);
    byId("signSelfSection").addEventListener("click", () => openSignature("Signer ma partie", signature => signScope("self-section/signature", signature)));
    byId("finalEvaluationForm").addEventListener("submit", saveFinalEvaluation);
    byId("signFinalEvaluation").addEventListener("click", () => openSignature("Signer l’évaluation finale", signature => signScope("final-evaluation/signature", signature)));
    byId("closeRecord").addEventListener("click", closeRecord);
    byId("newVersion").addEventListener("click", newVersion);
    byId("documentList").addEventListener("click", downloadDocument);
    setupSignaturePad();
  }

  async function refreshRecord() {
    const data = await api(`/v2/trainees/${encodeURIComponent(state.traineeId)}`);
    state.record = data.record;
    renderRecord();
  }

  function renderRecord() {
    const record = state.record;
    const trainee = record.trainee;
    document.title = `GHE · ${trainee.displayName}`;
    byId("recordIntro").innerHTML = `
      <span class="step-kicker">${esc(trainee.reference)} · VERSION ${trainee.recordVersion}</span>
      <h1>${esc(trainee.displayName)}</h1>
      <p>${esc(trainee.school || "Établissement non renseigné")} · du ${formatDate(trainee.startDate)} au ${formatDate(trainee.endDate)}</p>
      <div class="record-meta"><span>${trainee.status === "CLOSED" ? "Dossier clôturé" : "Stage en cours"}</span><span>Tuteur : ${esc(trainee.tutorName || "non renseigné")}</span>${trainee.arrivalNotes ? `<span>Repères d’arrivée enregistrés</span>` : ""}</div>
      ${state.mode === "user" && isManager() ? '<div class="record-actions"><button class="button" type="button" id="createShare">Créer le lien du stagiaire</button><button class="button" type="button" id="revokeShares">Révoquer les anciens liens</button></div>' : ""}`;
    byId("createShare")?.addEventListener("click", createShare);
    byId("revokeShares")?.addEventListener("click", revokeShares);
    renderObservations();
    renderSelfSection();
    renderFinalEvaluation();
    renderDocuments();
    byId("closureBox").hidden = !(state.mode === "user" && record.capabilities.close);
    byId("newVersionBox").hidden = !(state.mode === "user" && record.capabilities.createVersion);
  }

  function renderObservations() {
    const form = byId("observationForm");
    form.hidden = !(state.mode === "user" && state.record.capabilities.addObservation);
    const list = byId("observationList");
    if (!state.record.observations.length) { list.innerHTML = '<div class="empty-card">Aucune observation pour le moment.</div>'; return; }
    list.innerHTML = state.record.observations.map(observation => {
      const canSign = state.mode === "user" && state.user.id === observation.authorUserId && observation.recordVersion === state.record.trainee.recordVersion && !observation.signed && state.record.trainee.status === "OPEN";
      return `<article class="observation-card${observation.signed ? " signed" : ""}" data-observation-id="${esc(observation.id)}">
        <div class="observation-top"><div><h3>${esc(observation.categoryLabel)}</h3><small>${formatDate(observation.observedOn)} · ${esc(observation.authorName)}${observation.recordVersion !== state.record.trainee.recordVersion ? ` · version ${observation.recordVersion}` : ""}</small></div><span class="${observation.signed ? "signed-badge" : "unsigned-badge"}">${observation.signed ? "Signée" : "À signer"}</span></div>
        <p>${esc(observation.content)}</p>
        ${(observation.canEdit || canSign) ? `<div class="card-actions">${observation.canEdit ? '<button class="mini-button" type="button" data-edit-observation>Modifier</button>' : ""}${canSign ? '<button class="mini-button" type="button" data-sign-observation>Signer mon observation</button>' : ""}</div>` : ""}
      </article>`;
    }).join("");
  }

  async function observationAction(event) {
    const card = event.target.closest("[data-observation-id]");
    if (!card) return;
    const observation = state.record.observations.find(item => item.id === card.dataset.observationId);
    if (event.target.closest("[data-edit-observation]")) {
      const form = byId("observationForm");
      form.dataset.observationId = observation.id;
      form.elements.category.value = observation.category;
      form.elements.observedOn.value = observation.observedOn;
      form.elements.content.value = observation.content;
      byId("observationSubmit").textContent = "Enregistrer la modification";
      byId("cancelObservationEdit").hidden = false;
      form.scrollIntoView({ behavior: "smooth" });
    }
    if (event.target.closest("[data-sign-observation]")) {
      openSignature("Signer mon observation", signature => signScope(`observations/${encodeURIComponent(observation.id)}/signature`, signature));
    }
  }

  async function saveObservation(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = byId("observationSubmit");
    const values = formData(form);
    const observationId = form.dataset.observationId;
    pending(button, true);
    try {
      const path = observationId ? `/v2/trainees/${state.traineeId}/observations/${encodeURIComponent(observationId)}` : `/v2/trainees/${state.traineeId}/observations`;
      const data = await api(path, { method: observationId ? "PATCH" : "POST", body: { ...values, expectedVersion: state.record.trainee.recordVersion } });
      state.record = data.record;
      resetObservationForm();
      renderRecord();
      showNotice(byId("recordNotice"), observationId ? "Votre observation a été modifiée." : "Votre observation est enregistrée. Pensez à la signer quand elle est définitive.", "success");
    } catch (error) { showNotice(byId("recordNotice"), error.message, "error"); }
    finally { pending(button, false); }
  }

  function resetObservationForm() {
    const form = byId("observationForm");
    form.reset(); delete form.dataset.observationId;
    form.elements.observedOn.value = new Date().toISOString().slice(0, 10);
    byId("observationSubmit").textContent = "Ajouter mon observation";
    byId("cancelObservationEdit").hidden = true;
  }

  function renderSelfSection() {
    const form = byId("selfSectionForm");
    const readonly = byId("selfSectionReadonly");
    const section = state.record.selfSection || { expectations: "", progress: "", feedback: "", comments: "" };
    const selfSigned = state.record.signatures.some(signature => signature.scopeType === "SELF_SECTION");
    const editable = state.mode === "trainee" && state.record.capabilities.editSelfSection && !selfSigned;
    form.hidden = state.mode !== "trainee";
    readonly.hidden = state.mode === "trainee";
    for (const key of ["expectations", "progress", "feedback", "comments"]) form.elements[key].value = section[key] || "";
    form.querySelectorAll("textarea").forEach(input => { input.disabled = !editable; });
    byId("saveSelfSection").hidden = !editable;
    byId("signSelfSection").hidden = !editable;
    if (state.mode !== "trainee") readonly.innerHTML = readonlyBlocks([
      ["Attentes", section.expectations], ["Progression ressentie", section.progress], ["Retour sur le stage", section.feedback], ["Commentaire", section.comments],
    ], "Le stagiaire n’a pas encore complété cette partie.");
  }

  async function saveSelfSection(event) {
    event.preventDefault();
    const button = byId("saveSelfSection");
    pending(button, true);
    try {
      const data = await api(`/v2/trainees/${state.traineeId}/self-section`, { method: "PUT", body: { ...formData(event.currentTarget), expectedVersion: state.record.trainee.recordVersion } });
      state.record = data.record; renderRecord();
      showNotice(byId("recordNotice"), "Votre partie est enregistrée. Vous pouvez revenir plus tard ou la signer lorsqu’elle est définitive.", "success");
    } catch (error) { showNotice(byId("recordNotice"), error.message, "error"); }
    finally { pending(button, false); }
  }

  function buildRatingGrid() {
    byId("ratingGrid").innerHTML = ratingFields.map(([name, label]) => `<div class="rating-row"><label for="rating-${name}">${esc(label)}</label><select id="rating-${name}" name="${name}" required><option value="">Choisir…</option><option value="1">À acquérir</option><option value="2">En cours</option><option value="3">Acquis</option><option value="4">Maîtrisé</option><option value="NA">Éléments insuffisants</option></select></div>`).join("");
  }

  function renderFinalEvaluation() {
    const evaluation = state.record.finalEvaluation;
    const form = byId("finalEvaluationForm");
    const readonly = byId("finalReadonly");
    const finalSignatures = state.record.signatures.filter(signature => signature.scopeType === "FINAL_EVALUATION");
    const signed = finalSignatures.length > 0;
    const canEdit = state.mode === "user" && state.record.capabilities.editFinalEvaluation && !signed;
    const canSignUser = state.mode === "user" && (isManager() || isTutor()) && evaluation && !finalSignatures.some(signature => signature.signerUserId === state.user.id);
    const canSignTrainee = state.mode === "trainee" && evaluation && state.record.trainee.status === "OPEN" && !finalSignatures.some(signature => signature.signerRole === "TRAINEE");
    form.hidden = state.mode === "trainee" && !evaluation;
    readonly.hidden = state.mode !== "trainee" || !evaluation;
    const ratings = evaluation?.ratings || {};
    ratingFields.forEach(([name]) => { form.elements[name].value = ratings[name] ?? ""; form.elements[name].disabled = !canEdit; });
    for (const name of ["strengths", "improvements", "summary"]) { form.elements[name].value = evaluation?.[name] || ""; form.elements[name].disabled = !canEdit; }
    byId("saveFinalEvaluation").hidden = !canEdit;
    byId("signFinalEvaluation").hidden = !(canSignUser || canSignTrainee);
    if (state.mode === "trainee" && evaluation) readonly.innerHTML = readonlyBlocks([
      ...ratingFields.map(([name, label]) => [label, ratingLabel(ratings[name])]),
      ["Points forts", evaluation.strengths], ["Points à améliorer", evaluation.improvements], ["Synthèse", evaluation.summary],
    ]);
  }

  async function saveFinalEvaluation(event) {
    event.preventDefault();
    const button = byId("saveFinalEvaluation");
    pending(button, true);
    const values = formData(event.currentTarget);
    const ratings = {};
    ratingFields.forEach(([name]) => { ratings[name] = values[name] === "NA" ? "NA" : Number(values[name]); delete values[name]; });
    try {
      const data = await api(`/v2/trainees/${state.traineeId}/final-evaluation`, { method: "PUT", body: { ...values, ratings, expectedVersion: state.record.trainee.recordVersion } });
      state.record = data.record; renderRecord();
      showNotice(byId("recordNotice"), "L’évaluation finale est enregistrée. Vérifiez-la avant de signer : la signature la figera.", "success");
    } catch (error) { showNotice(byId("recordNotice"), error.message, "error"); }
    finally { pending(button, false); }
  }

  async function signScope(scope, signatureDataUrl) {
    const data = await api(`/v2/trainees/${state.traineeId}/${scope}`, { method: "POST", body: { signatureDataUrl, expectedVersion: state.record.trainee.recordVersion } });
    state.record = data.record; renderRecord();
    showNotice(byId("recordNotice"), "La signature est enregistrée et cette partie est maintenant figée.", "success");
  }

  async function createShare() {
    try {
      const data = await api(`/v2/trainees/${state.traineeId}/share-link`, { method: "POST", body: { expiresDays: 90 } });
      try { await navigator.clipboard.writeText(data.link); showNotice(byId("recordNotice"), `Lien copié. Il reste valable jusqu’au ${formatDate(data.expiresAt)}.`, "success"); }
      catch { window.prompt("Copiez ce lien et transmettez-le uniquement au stagiaire :", data.link); }
    } catch (error) { showNotice(byId("recordNotice"), error.message, "error"); }
  }

  async function revokeShares() {
    if (!confirm("Révoquer tous les liens stagiaire déjà créés pour cette fiche ?")) return;
    try { await api(`/v2/trainees/${state.traineeId}/share-links`, { method: "DELETE" }); showNotice(byId("recordNotice"), "Tous les anciens liens ont été révoqués.", "success"); }
    catch (error) { showNotice(byId("recordNotice"), error.message, "error"); }
  }

  async function closeRecord() {
    if (!confirm("Créer le document définitif et figer cette version ?")) return;
    const button = byId("closeRecord"); pending(button, true, "Création du document…");
    try {
      const data = await api(`/v2/trainees/${state.traineeId}/close`, { method: "POST", body: { expectedVersion: state.record.trainee.recordVersion } });
      state.record = data.record; renderRecord();
      showNotice(byId("recordNotice"), "Le document définitif a été créé et archivé. Cette version est désormais figée.", "success");
    } catch (error) {
      const extra = error.details?.observations?.length ? ` Observations concernées : ${error.details.observations.join(", ")}.` : "";
      showNotice(byId("recordNotice"), error.message + extra, "error");
    } finally { pending(button, false); }
  }

  async function newVersion() {
    if (!confirm("Créer une nouvelle version modifiable tout en conservant le document signé actuel ?")) return;
    const button = byId("newVersion"); pending(button, true, "Création…");
    try {
      const data = await api(`/v2/trainees/${state.traineeId}/new-version`, { method: "POST", body: { expectedVersion: state.record.trainee.recordVersion } });
      state.record = data.record; renderRecord();
      showNotice(byId("recordNotice"), `La version ${state.record.trainee.recordVersion} est ouverte. Les anciennes signatures et le PDF restent attachés à la version précédente.`, "success");
    } catch (error) { showNotice(byId("recordNotice"), error.message, "error"); }
    finally { pending(button, false); }
  }

  function renderDocuments() {
    const list = byId("documentList");
    if (!state.record.documents.length) { list.innerHTML = '<div class="empty-card">Aucun document définitif pour le moment.</div>'; return; }
    list.innerHTML = state.record.documents.map(document => `<div class="document-card"><div><strong>Document définitif · version ${document.version}</strong><small>Créé le ${formatDateTime(document.createdAt)} · empreinte ${esc(document.sha256.slice(0, 14))}…</small></div><button class="button" type="button" data-download-url="${esc(document.downloadUrl)}" data-version="${document.version}">Télécharger le PDF</button></div>`).join("");
  }

  async function downloadDocument(event) {
    const button = event.target.closest("[data-download-url]");
    if (!button) return;
    pending(button, true, "Téléchargement…");
    try {
      const response = await fetch(API + button.dataset.downloadUrl, { credentials: "include", cache: "no-store", headers: { Accept: "application/pdf" } });
      if (!response.ok) {
        let data = {};
        try { data = await response.json(); } catch { /* réponse non JSON */ }
        throw friendlyError(data.message || "Le document ne peut pas être téléchargé.");
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `suivi-stage-${state.record.trainee.reference}-v${button.dataset.version}.pdf`;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 5_000);
    } catch (error) { showNotice(byId("recordNotice"), error.message, "error"); }
    finally { pending(button, false); }
  }

  function readonlyBlocks(entries, emptyMessage = "Aucune information renseignée.") {
    const filled = entries.filter(([, value]) => value !== undefined && value !== null && String(value).trim());
    return filled.length ? filled.map(([label, value]) => `<div class="readonly-block"><strong>${esc(label)}</strong><p>${esc(value)}</p></div>`).join("") : `<p>${esc(emptyMessage)}</p>`;
  }

  function ratingLabel(value) { return ({ 1: "À acquérir", 2: "En cours", 3: "Acquis", 4: "Maîtrisé", NA: "Éléments insuffisants" })[value] || "Non renseigné"; }

  function setupSignaturePad() {
    const dialog = byId("signatureDialog");
    const canvas = byId("signatureCanvas");
    const context = canvas.getContext("2d");
    const resize = () => {
      const ratio = Math.max(1, window.devicePixelRatio || 1);
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.round(rect.width * ratio); canvas.height = Math.round(rect.height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0); context.lineWidth = 2.2; context.lineCap = "round"; context.lineJoin = "round"; context.strokeStyle = "#102331";
      context.fillStyle = "#fff"; context.fillRect(0, 0, rect.width, rect.height); state.drawn = false;
    };
    const point = event => { const rect = canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
    canvas.addEventListener("pointerdown", event => { state.drawing = true; state.drawn = true; canvas.setPointerCapture(event.pointerId); const p = point(event); context.beginPath(); context.moveTo(p.x, p.y); });
    canvas.addEventListener("pointermove", event => { if (!state.drawing) return; const p = point(event); context.lineTo(p.x, p.y); context.stroke(); });
    const end = () => { state.drawing = false; };
    canvas.addEventListener("pointerup", end); canvas.addEventListener("pointercancel", end);
    byId("clearSignature").addEventListener("click", resize);
    byId("confirmSignature").addEventListener("click", async () => {
      if (!state.drawn) { showNotice(byId("recordNotice"), "Tracez votre signature avant de confirmer.", "error"); return; }
      const button = byId("confirmSignature"); pending(button, true, "Enregistrement…");
      try { await state.signatureAction(canvas.toDataURL("image/png")); dialog.close(); }
      catch (error) { dialog.close(); showNotice(byId("recordNotice"), error.message, "error"); }
      finally { pending(button, false); state.signatureAction = null; }
    });
    dialog.addEventListener("close", () => { state.signatureAction = null; });
    window.addEventListener("resize", () => { if (dialog.open) resize(); });
    state.resizeSignature = resize;
  }

  function openSignature(title, action) {
    const dialog = byId("signatureDialog");
    state.signatureAction = action;
    byId("signatureTitle").textContent = title;
    dialog.showModal();
    requestAnimationFrame(() => state.resizeSignature());
  }

  if (page === "dashboard") bootDashboard();
  if (page === "record") bootRecord();
})();
