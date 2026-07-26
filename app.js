const API_URL = "https://script.google.com/macros/s/AKfycbyT31o3uSvwy-WrVZ4QGRQ8u9js6tpC4a1bzUy3VHl_ccySpAnFnjjPzzj3Vcrco6X_/exec";

const COMPETENCES = [
  "Identitovigilance",
  "Hygiène",
  "Manutention et conduite du matériel",
  "Relation et communication avec le patient",
  "Compréhension des missions et utilisation du téléphone",
  "Repérage dans les bâtiments",
  "Communication avec les équipes",
  "Gestion des difficultés et imprévus",
  "Organisation et priorisation",
  "Autonomie globale"
];

let agents = [];
let currentAgent = null;

const $ = (selector) => document.querySelector(selector);

function norm(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function apiGet(action, params = {}) {
  const url = new URL(API_URL);
  url.searchParams.set("action", action);

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  });

  const response = await fetch(url.toString(), {
    method: "GET",
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Erreur du serveur (${response.status}).`);
  }

  const result = await response.json();
  if (!result.ok) {
    throw new Error(result.error || result.message || "La demande a échoué.");
  }

  return result;
}

async function apiPost(payload) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=utf-8"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Erreur du serveur (${response.status}).`);
  }

  const result = await response.json();
  if (!result.ok && !result.duplicate) {
    throw new Error(result.error || result.message || "La demande a échoué.");
  }

  return result;
}

function setLoadingList(message) {
  $("#agent-list").innerHTML = `<div class="empty-state"><p>${escapeHtml(message)}</p></div>`;
}

function renderAgents(filter = "") {
  const query = norm(filter);
  const filtered = agents.filter((agent) =>
    norm(`${agent.nom}${agent.prenom}${agent.matricule || ""}`).includes(query)
  );

  $("#agent-count").textContent = filtered.length;

  if (!filtered.length) {
    $("#agent-list").innerHTML = `
      <div class="empty-state">
        <h3>Aucun agent trouvé</h3>
        <p>Aucun dossier ne correspond à cette recherche.</p>
      </div>`;
    return;
  }

  $("#agent-list").innerHTML = filtered
    .map((agent) => {
      const index = agents.findIndex((item) => item.idAgent === agent.idAgent);
      return `
        <button class="agent-card" data-index="${index}">
          <div>
            <strong>${escapeHtml(agent.prenom)} ${escapeHtml(agent.nom)}</strong>
            <span>
              ${escapeHtml(agent.etape || "Dossier créé")}
              ${agent.matricule ? ` · Matricule ${escapeHtml(agent.matricule)}` : ""}
            </span>
          </div>
          <span>›</span>
        </button>`;
    })
    .join("");

  document.querySelectorAll(".agent-card").forEach((button) => {
    button.onclick = () => openAgent(Number(button.dataset.index));
  });
}

function renderCompetences(agent) {
  const evaluations = agent.evaluations || {};

  $("#competence-grid").innerHTML = COMPETENCES.map(
    (competence, index) => `
      <label>
        ${escapeHtml(competence)}
        <select data-competence="${index}">
          <option>Non observé</option>
          <option>Découvert</option>
          <option>Réalisé avec accompagnement</option>
          <option>Réalisé avec une aide ponctuelle</option>
          <option>Autonome</option>
          <option>À revoir prioritairement</option>
        </select>
      </label>`
  ).join("");

  document.querySelectorAll("[data-competence]").forEach((select) => {
    const competence = COMPETENCES[Number(select.dataset.competence)];
    select.value = evaluations[competence] || "Non observé";
  });
}

function renderAnswers(agent) {
  const answers = agent.agentAnswers || {};
  const entries = Object.entries(answers);

  $("#agent-answers").innerHTML = entries.length
    ? entries
        .map(
          ([question, answer]) => `
            <article class="answer-card">
              <strong>${escapeHtml(question)}</strong>
              <p>${escapeHtml(answer || "Non renseigné")}</p>
            </article>`
        )
        .join("")
    : `
      <div class="empty-state">
        <h3>Aucune réponse reçue</h3>
        <p>Les réponses envoyées par l’agent apparaîtront ici.</p>
      </div>`;
}

function fillFields(agent) {
  document.querySelectorAll("[data-field]").forEach((element) => {
    element.value = agent[element.dataset.field] ?? "";
  });
}

async function openAgent(index) {
  const summary = agents[index];
  if (!summary) return;

  $("#agent-file").hidden = false;
  $("#agent-name").textContent = `${summary.prenom} ${summary.nom}`;
  $("#agent-meta").textContent = "Chargement du dossier…";
  $("#agent-file").scrollIntoView({ behavior: "smooth" });

  try {
    const result = await apiGet("lire_agent", { idAgent: summary.idAgent });
    const data = result.agent;
    const suivi = data.suiviChef || {};

    currentAgent = {
      idAgent: data.idAgent,
      nom: data.nom || "",
      prenom: data.prenom || "",
      matricule: data.matricule || "",
      telephone: data.telephone || "",
      dateArrivee: data.dateArrivee || "",
      sitePrincipal: data.sitePrincipal || "",
      etape: data.etape || "Dossier créé",
      agentAnswers: data.reponsesAgent || {},
      chefReferent: suivi.chefReferent || "",
      statutSuivi: suivi.statutSuivi || "",
      pointsForts: suivi.pointsForts || "",
      difficultes: suivi.difficultes || "",
      observationGenerale: suivi.observations || "",
      action: suivi.actionsPrevoir || "",
      echeance: suivi.echeance || "",
      prochainBilan: suivi.prochainBilan || "",
      decision: suivi.decisionSuite || "",
      bilan: suivi.commentaireGeneral || "",
      equipe: suivi.equipe || "",
      contrat: suivi.contrat || "",
      accompagnateur: suivi.accompagnateur || "",
      dureeDoublure: suivi.dureeDoublure || "",
      badgeRemis: suivi.badgeRemis || "Non",
      telephoneRemis: suivi.telephoneRemis || "Non",
      responsableAction: suivi.responsableAction || "",
      evaluations: suivi.evaluations || {}
    };

    $("#agent-name").textContent = `${currentAgent.prenom} ${currentAgent.nom}`;
    $("#agent-meta").textContent = [
      currentAgent.matricule ? `Matricule : ${currentAgent.matricule}` : "",
      currentAgent.sitePrincipal || "",
      currentAgent.etape || ""
    ]
      .filter(Boolean)
      .join(" · ");

    fillFields(currentAgent);
    renderCompetences(currentAgent);
    renderAnswers(currentAgent);
  } catch (error) {
    $("#agent-meta").textContent = error.message;
    alert(`Impossible d’ouvrir le dossier : ${error.message}`);
  }
}

function collectCurrent() {
  document.querySelectorAll("[data-field]").forEach((element) => {
    currentAgent[element.dataset.field] = element.value;
  });

  currentAgent.evaluations = {};
  document.querySelectorAll("[data-competence]").forEach((element) => {
    const competence = COMPETENCES[Number(element.dataset.competence)];
    currentAgent.evaluations[competence] = element.value;
  });
}

async function loadAgents() {
  setLoadingList("Chargement des dossiers…");

  try {
    const result = await apiGet("liste_agents");
    agents = Array.isArray(result.agents) ? result.agents : [];
    renderAgents($("#agent-search").value);
  } catch (error) {
    agents = [];
    $("#agent-count").textContent = "0";
    $("#agent-list").innerHTML = `
      <div class="empty-state">
        <h3>Connexion impossible</h3>
        <p>${escapeHtml(error.message)}</p>
      </div>`;
  }
}

$("#new-agent").onclick = () => {
  $("#new-agent-form").reset();
  $("#duplicate-warning").hidden = true;
  $("#new-agent-dialog").showModal();
};

$("#create-agent").onclick = async (event) => {
  event.preventDefault();

  const form = $("#new-agent-form");
  const values = Object.fromEntries(new FormData(form).entries());

  if (!values.nom.trim() || !values.prenom.trim() || !values.dateArrivee) {
    alert("Nom, prénom et date d’arrivée sont obligatoires.");
    return;
  }

  const button = $("#create-agent");
  button.disabled = true;
  button.textContent = "Création…";

  try {
    let result = await apiPost({
      action: "creer_agent_chef",
      agent: values
    });

    if (result.duplicate) {
      const details = (result.dossiers || [])
        .map((item) => `${item.prenom} ${item.nom}${item.matricule ? ` (${item.matricule})` : ""}`)
        .join("\n");

      const confirmed = confirm(
        `Un dossier correspondant existe déjà.${details ? `\n\n${details}` : ""}\n\nCréer malgré tout un nouveau dossier ?`
      );

      if (!confirmed) return;

      result = await apiPost({
        action: "creer_agent_chef",
        agent: values,
        forcerCreation: true
      });
    }

    $("#new-agent-dialog").close();
    await loadAgents();

    const createdIndex = agents.findIndex((agent) => agent.idAgent === result.idAgent);
    if (createdIndex >= 0) {
      await openAgent(createdIndex);
    }
  } catch (error) {
    alert(`Création impossible : ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = "Créer le dossier";
  }
};

$("#agent-search").oninput = (event) => renderAgents(event.target.value);
$("#close-file").onclick = () => {
  $("#agent-file").hidden = true;
  currentAgent = null;
};

document.querySelectorAll(".tab").forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll(".tab, .tab-panel").forEach((item) => {
      item.classList.remove("active");
    });

    tab.classList.add("active");
    document.querySelector(`[data-panel="${tab.dataset.tab}"]`).classList.add("active");
  };
});

$("#save-file").onclick = async () => {
  if (!currentAgent || !currentAgent.idAgent) {
    alert("Aucun dossier agent n’est ouvert.");
    return;
  }

  collectCurrent();

  const button = $("#save-file");
  const status = $("#save-status");
  button.disabled = true;
  status.textContent = "Enregistrement…";

  try {
    await apiPost({
      action: "enregistrer_suivi_chef",
      idAgent: currentAgent.idAgent,
      suivi: {
        chefReferent: currentAgent.chefReferent,
        statutSuivi: currentAgent.statutSuivi,
        pointsForts: currentAgent.pointsForts,
        difficultes: currentAgent.difficultes,
        observations: currentAgent.observationGenerale,
        actionsPrevoir: currentAgent.action,
        echeance: currentAgent.echeance,
        prochainBilan: currentAgent.prochainBilan,
        decisionSuite: currentAgent.decision,
        commentaireGeneral: currentAgent.bilan,
        equipe: currentAgent.equipe,
        contrat: currentAgent.contrat,
        accompagnateur: currentAgent.accompagnateur,
        dureeDoublure: currentAgent.dureeDoublure,
        badgeRemis: currentAgent.badgeRemis,
        telephoneRemis: currentAgent.telephoneRemis,
        responsableAction: currentAgent.responsableAction,
        evaluations: currentAgent.evaluations
      }
    });

    status.textContent = "Enregistré dans Google Sheets.";
    await loadAgents();
  } catch (error) {
    status.textContent = `Erreur : ${error.message}`;
  } finally {
    button.disabled = false;
    setTimeout(() => {
      status.textContent = "";
    }, 4000);
  }
};

loadAgents();
