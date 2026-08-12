const id=new URL(location.href).searchParams.get("id"),status=q("#status"),view=q("#view"),edit=q("#edit"),follow=q("#follow"),form=q("#editForm"),es=q("#editStatus");
let agent=null,fullLoaded=false,warmed=false;

function warmAgentModules(){
  if(warmed||!id)return;
  warmed=true;
  setTimeout(()=>{
    apiGet("getFirstDay",{id}).catch(()=>{});
    apiGet("listEvaluations",{id}).then(data=>{
      const latest=(data.evaluations||[])[0];
      if(latest?.id_evaluation)apiGet("getEvaluation",{id:latest.id_evaluation}).catch(()=>{});
    }).catch(()=>{});
  },80);
}

function paint(a,{partial=false}={}){
  agent={...(agent||{}),...a};
  q("#name").textContent=`${agent.nom||""} ${agent.prenom||""}`.trim()||"Agent";
  q("#verify").innerHTML=`Statut : <strong>${esc(agent.verification||"")}</strong>`;
  q("#details").innerHTML=`<div class="detail"><small>Téléphone</small><strong>${esc(agent.telephone||"—")}</strong></div><div class="detail"><small>Matricule</small><strong>${esc(agent.matricule||"Non renseigné")}</strong></div><div class="detail"><small>Date d’arrivée</small><strong>${esc(displayDate(agent.date_arrivee))}</strong></div><div class="detail"><small>Expérience</small><strong>${esc(agent.experiences||"—")}</strong></div>`;
  const fileBtn=q("#fileBtn");
  fileBtn.href=agent.fichier_brouillon_url||"#";
  fileBtn.hidden=!agent.fichier_brouillon_url;
  q("#integrationLink").href=`suivi-integration.html?id=${encodeURIComponent(agent.id_agent||id)}`;
  q("#evaluationsLink").href=`evaluations.html?id=${encodeURIComponent(agent.id_agent||id)}`;
  q("#eventsLink").href=`situations-evenements.html?id=${encodeURIComponent(agent.id_agent||id)}`;
  for(const[k,v]of Object.entries({nom:agent.nom,prenom:agent.prenom,telephone:agent.telephone,matricule:agent.matricule,date_arrivee:agent.date_arrivee,experiences:agent.experiences}))if(form.elements[k])form.elements[k].value=v||"";
  view.hidden=false;
  follow.hidden=false;
  q("#editBtn").disabled=partial&&!fullLoaded;
  if(partial)setStatus(status,"warn","Fiche disponible. Les détails se mettent à jour en arrière-plan…");
  else status.className="status";
  warmAgentModules();
}

async function loadSummary(){
  const d=await apiGet("listAgents");
  return(d.agents||[]).find(a=>String(a.id_agent||"")===String(id||""))||null;
}

async function loadFull(){
  const d=await apiGet("getAgent",{id});
  if(!d.agent)throw new Error("Agent introuvable.");
  fullLoaded=true;
  paint(d.agent,{partial:false});
  return d.agent;
}

async function load(){
  if(!id){setStatus(status,"err","Identifiant agent manquant.");return;}
  const fullPromise=loadFull();
  const summaryPromise=loadSummary().catch(()=>null);
  try{
    const first=await Promise.race([
      fullPromise.then(a=>({type:"full",a})),
      summaryPromise.then(a=>({type:"summary",a}))
    ]);
    if(first.type==="full")return;
    if(first.a){paint(first.a,{partial:true});fullPromise.catch(()=>setStatus(status,"warn","La fiche est accessible. Les détails complets seront réessayés automatiquement."));return;}
    await fullPromise;
  }catch(e){
    const summary=await summaryPromise;
    if(summary){paint(summary,{partial:true});setStatus(status,"warn","La fiche est accessible. Les détails complets sont momentanément indisponibles.");return;}
    setStatus(status,"err",esc(e.message));
  }
}

q("#editBtn").onclick=()=>{if(!fullLoaded)return;edit.hidden=false;edit.scrollIntoView({behavior:"smooth"});};
q("#cancel").onclick=()=>{edit.hidden=true;};
form.addEventListener("submit",async e=>{
  e.preventDefault();
  setStatus(es,"warn","Modification et vérification en cours…");
  try{
    const d=await apiPost("updateAgent",{id_agent:id,...formObject(form)});
    if(!d.ok){setStatus(es,"err",esc(d.message||d.code));return;}
    fullLoaded=true;
    paint(d.agent,{partial:false});
    setStatus(es,"ok","✓ Modifications enregistrées et relues dans la source centrale.");
    setTimeout(()=>{edit.hidden=true;},900);
  }catch(err){setStatus(es,"err","Échec : "+esc(err.message));}
});

load();
