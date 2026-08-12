const list=q("#list"),search=q("#search"),status=q("#status");
let agents=[];

function render(){
  const term=search.value.trim().toLowerCase();
  const shown=agents.filter(a=>`${a.nom||""} ${a.prenom||""} ${a.matricule||""}`.toLowerCase().includes(term));
  if(!shown.length){
    list.innerHTML='<div class="empty">Aucun agent trouvé.</div>';
    return;
  }
  list.innerHTML=shown.map(a=>`<a class="agent" href="agent.html?id=${encodeURIComponent(a.id_agent)}"><div><strong>${esc(a.nom)} ${esc(a.prenom)}</strong><div class="meta">${a.matricule?`Matricule ${esc(a.matricule)}`:"Sans matricule"}</div></div><span class="badge ${(a.verification||"").toLowerCase()}">${esc(a.verification||"")}</span></a>`).join("");
}

async function load({force=false}={}){
  setStatus(status,"warn","Chargement des agents…");
  if(force&&window.GHEDataCache)GHEDataCache.clearApiForAgent();
  try{
    const d=await apiGet("listAgents");
    agents=Array.isArray(d.agents)?d.agents:[];
    status.className="status";
    render();
  }catch(e){
    setStatus(status,"err","Impossible de charger la liste : "+esc(e.message));
  }
}

search.addEventListener("input",render);
q("#refresh").addEventListener("click",()=>load({force:true}));
load();
