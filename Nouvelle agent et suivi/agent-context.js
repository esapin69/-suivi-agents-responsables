const AgentContext = (() => {
  const params = new URLSearchParams(location.search);
  const id = params.get("id");

  function link(path, extra = {}) {
    const url = new URL(path, location.href);
    if (id) url.searchParams.set("id", id);
    for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
    return url.pathname.split("/").pop() + url.search;
  }

  function preserveLinks() {
    document.querySelectorAll("[data-agent-link]").forEach(element => {
      const extra = {};
      if (element.dataset.step) extra.etape = element.dataset.step;
      element.href = link(element.dataset.agentLink, extra);
    });
  }

  function apply(agent, partial = false) {
    document.querySelectorAll("[data-agent-name]").forEach(element => {
      element.textContent = `${agent.nom || ""} ${agent.prenom || ""}`.trim() || "Agent";
    });
    document.querySelectorAll("[data-agent-meta]").forEach(element => {
      element.textContent = agent.matricule ? `Matricule ${agent.matricule}` : "Sans matricule renseigné";
    });
    const status = q("#contextStatus");
    if (status) {
      if (partial) setStatus(status, "warn", "Dossier affiché. Les détails se mettent à jour en arrière-plan…");
      else status.className = "status";
    }
    return agent;
  }

  async function summaryFromList() {
    const data = await apiGet("listAgents");
    return (data.agents || []).find(agent => String(agent.id_agent || "") === String(id || "")) || null;
  }

  async function fullAgent() {
    const data = await apiGet("getAgent", {id});
    if (!data.agent) throw new Error("Agent introuvable.");
    return data.agent;
  }

  async function load() {
    preserveLinks();
    const status = q("#contextStatus");
    if (!id) {
      setStatus(status, "err", "Agent non identifié. Revenez à la liste et ouvrez sa fiche.");
      document.querySelectorAll("[data-agent-link]").forEach(element => element.removeAttribute("href"));
      throw new Error("Identifiant agent manquant.");
    }

    const fullPromise = fullAgent();
    const summaryPromise = summaryFromList().catch(() => null);

    try {
      const first = await Promise.race([
        fullPromise.then(agent => ({type:"full", agent})),
        summaryPromise.then(agent => ({type:"summary", agent}))
      ]);

      if (first.type === "full") return apply(first.agent, false);
      if (first.agent) {
        apply(first.agent, true);
        fullPromise.then(agent => apply(agent, false)).catch(() => {
          if (status) setStatus(status, "warn", "Dossier disponible. Les informations détaillées seront réessayées à la prochaine ouverture.");
        });
        return first.agent;
      }

      const agent = await fullPromise;
      return apply(agent, false);
    } catch (error) {
      const summary = await summaryPromise;
      if (summary) {
        apply(summary, true);
        return summary;
      }
      setStatus(status, "err", `Impossible de charger l’agent : ${esc(error.message)}`);
      throw error;
    }
  }

  return {id, link, load, preserveLinks};
})();
