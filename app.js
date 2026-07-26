const sections = [
  "Accueil et intégration",
  "Connaissance des bâtiments",
  "Organisation du travail",
  "Réalisation des transports",
  "Prise en charge des patients",
  "Identitovigilance et sécurité",
  "Communication",
  "Autonomie",
  "Points forts",
  "Difficultés rencontrées",
  "Actions à prévoir",
  "Observations complémentaires"
];

const agents = [];

const searchInput = document.querySelector("#agent-search");
const agentList = document.querySelector("#agent-list");
const agentCount = document.querySelector("#agent-count");
const agentFile = document.querySelector("#agent-file");
const agentName = document.querySelector("#agent-name");
const sectionsContainer = document.querySelector("#followup-sections");
const closeFileButton = document.querySelector("#close-file");
const saveButton = document.querySelector("#save-file");
const saveStatus = document.querySelector("#save-status");

function renderSections(agent = {}) {
  sectionsContainer.innerHTML = sections.map((title, index) => {
    const key = `section-${index}`;
    const agentAnswer = agent.agentAnswers?.[key] || "Aucune réponse transmise pour cette rubrique.";
    const managerAnswer = agent.managerAnswers?.[key] || "";

    return `
      <section class="followup-section">
        <h3>${title}</h3>
        <div class="agent-response">
          <strong>Ce que l’agent a répondu</strong>
          <p>${escapeHtml(agentAnswer)}</p>
        </div>
        <label class="response-field">
          Observation du chef
          <textarea data-section="${key}" placeholder="Écrire une observation…">${escapeHtml(managerAnswer)}</textarea>
        </label>
      </section>
    `;
  }).join("");
}

function renderAgents(filter = "") {
  const normalizedFilter = filter.trim().toLowerCase();
  const filtered = agents.filter(agent =>
    `${agent.firstName} ${agent.lastName}`.toLowerCase().includes(normalizedFilter)
  );

  agentCount.textContent = String(filtered.length);

  if (!filtered.length) {
    agentList.innerHTML = `
      <div class="empty-state">
        <h3>Aucun agent enregistré</h3>
        <p>Les dossiers apparaîtront ici lorsque le site sera relié au fichier de stockage.</p>
      </div>
    `;
    return;
  }

  agentList.innerHTML = filtered.map(agent => `
    <button class="agent-card" type="button" data-agent-id="${agent.id}">
      <div>
        <strong>${escapeHtml(agent.firstName)} ${escapeHtml(agent.lastName)}</strong>
        <span>${escapeHtml(agent.status || "Suivi en cours")}</span>
      </div>
      <span aria-hidden="true">›</span>
    </button>
  `).join("");

  document.querySelectorAll("[data-agent-id]").forEach(button => {
    button.addEventListener("click", () => openAgent(button.dataset.agentId));
  });
}

function openAgent(id) {
  const agent = agents.find(item => item.id === id);
  if (!agent) return;

  agentName.textContent = `${agent.firstName} ${agent.lastName}`;
  renderSections(agent);
  agentFile.hidden = false;
  agentFile.scrollIntoView({ behavior: "smooth", block: "start" });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

searchInput?.addEventListener("input", event => renderAgents(event.target.value));

closeFileButton?.addEventListener("click", () => {
  agentFile.hidden = true;
});

saveButton?.addEventListener("click", () => {
  saveStatus.textContent = "La connexion au script sera ajoutée à l’étape suivante.";
  window.setTimeout(() => {
    saveStatus.textContent = "";
  }, 3500);
});

renderSections();
renderAgents();
