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

  async function load() {
    preserveLinks();
    const status = q("#contextStatus");
    if (!id) {
      setStatus(status, "err", "Agent non identifié. Revenez à la liste et ouvrez sa fiche.");
      document.querySelectorAll("[data-agent-link]").forEach(element => element.removeAttribute("href"));
      throw new Error("Identifiant agent manquant.");
    }
    try {
      const data = await apiGet("getAgent", {id});
      if (!data.agent) throw new Error("Agent introuvable.");
      const agent = data.agent;
      document.querySelectorAll("[data-agent-name]").forEach(element => {
        element.textContent = `${agent.nom} ${agent.prenom}`;
      });
      document.querySelectorAll("[data-agent-meta]").forEach(element => {
        element.textContent = agent.matricule ? `Matricule ${agent.matricule}` : "Sans matricule renseigné";
      });
      status.className = "status";
      return agent;
    } catch (error) {
      setStatus(status, "err", `Impossible de charger l’agent : ${esc(error.message)}`);
      throw error;
    }
  }

  return {id, link, load, preserveLinks};
})();
