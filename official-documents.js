const OFFICIAL_DOCUMENTS = Object.freeze([
  {key:"evaluation_2026", title:"Évaluation officielle 2026", route:"Nouvelle%20agent%20et%20suivi/evaluations.html"}
]);

const officialState = {agents:[], selected:null, evaluations:[]};
const officialEl = id => document.getElementById(id);
const officialEsc = value => String(value ?? "").replace(/[&<>'"]/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char]));
const officialNorm = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLocaleLowerCase("fr").trim();

function officialName(agent){
  return `${agent?.prenom || ""} ${agent?.nom || ""}`.trim() || "Agent";
}

function setOfficialStatus(kind, message){
  const box=officialEl("pageStatus");
  box.className=`page-status show ${kind}`;
  box.textContent=message;
}

function clearOfficialStatus(){
  const box=officialEl("pageStatus");
  box.className="page-status";
  box.textContent="";
}

function renderAgentResults(){
  const query=officialNorm(officialEl("agentSearch").value);
  const box=officialEl("agentResults");
  if(query.length<2){box.innerHTML="";return;}
  const matches=officialState.agents.filter(agent=>officialNorm(`${agent.prenom||""} ${agent.nom||""} ${agent.matricule||""}`).includes(query)).slice(0,10);
  if(!matches.length){box.innerHTML='<div class="agent-result"><strong>Aucun agent trouvé</strong><small>Vérifiez le nom ou le prénom.</small></div>';return;}
  box.innerHTML=matches.map(agent=>{
    const selected=officialState.selected&&String(officialState.selected.id_agent)===String(agent.id_agent);
    return `<button type="button" class="agent-result${selected?" selected":""}" data-agent-id="${officialEsc(agent.id_agent)}"><strong>${officialEsc(officialName(agent))}</strong><small>${agent.matricule?`Matricule ${officialEsc(agent.matricule)}`:"Matricule non renseigné"}</small></button>`;
  }).join("");
  box.querySelectorAll("[data-agent-id]").forEach(button=>button.addEventListener("click",()=>selectOfficialAgent(button.dataset.agentId)));
}

function renderSelectedAgent(agent){
  const box=officialEl("selectedAgent");
  box.hidden=false;
  box.innerHTML=`<strong>${officialEsc(officialName(agent))}</strong><span>${agent.matricule?`Matricule ${officialEsc(agent.matricule)}`:"Matricule non renseigné"}${agent.date_arrivee?` · Arrivée ${officialEsc(agent.date_arrivee)}`:""}</span>`;
}

function preflightItem(kind, title, detail){
  const mark=kind==="ok"?"✓":kind==="warn"?"!":"×";
  return `<div class="check ${kind}"><span class="mark">${mark}</span><div><strong>${officialEsc(title)}</strong><span>${officialEsc(detail)}</span></div></div>`;
}

function evaluationHasContent(evaluation){
  if(!evaluation)return false;
  const criteria=Object.values(evaluation.criteres||{});
  const observed=criteria.some(value=>value&&value!=="Éléments insuffisants pour évaluer");
  const notes=["observations_1","observations_2","observations_3","observations_4","observations_5","observations_generales"].some(key=>String(evaluation[key]||"").trim());
  return observed||notes;
}

function evaluationMissingFinalFields(evaluation){
  if(!evaluation)return [];
  const missing=[];
  if(!String(evaluation.grade||"").trim())missing.push("grade");
  if(!String(evaluation.service||"").trim())missing.push("service");
  if(!String(evaluation.date_evaluation||"").trim())missing.push("date d’évaluation");
  if(!String(evaluation.evaluateur||"").trim())missing.push("responsable évaluateur");
  if(!String(evaluation.lyon_le||"").trim())missing.push("date de signature");
  if(!["OUI","NON"].includes(String(evaluation.garder_agent||"").toUpperCase()))missing.push("décision finale");
  return missing;
}

function renderEvaluationPreflight(agent, evaluations){
  const checks=[];
  const draft=evaluations.filter(item=>item.statut==="BROUILLON").sort((a,b)=>Number(b.version||0)-Number(a.version||0))[0]||null;
  const latest=evaluations.filter(item=>item.statut==="VALIDE").sort((a,b)=>Number(b.version||0)-Number(a.version||0))[0]||null;

  checks.push(preflightItem("ok","Agent identifié",officialName(agent)));
  if(agent.matricule)checks.push(preflightItem("ok","Matricule disponible",agent.matricule));
  else checks.push(preflightItem("warn","Matricule manquant","Vous pouvez poursuivre, mais il faudra le vérifier si le formulaire officiel l’exige."));

  if(!draft){
    checks.push(preflightItem("warn","Aucun brouillon en cours","Le formulaire s’ouvrira vide avec les informations administratives déjà connues de l’agent."));
  }else{
    checks.push(preflightItem("ok","Brouillon retrouvé",`Version ${draft.version||"en cours"} : vos réponses déjà enregistrées seront reprises.`));
    if(evaluationHasContent(draft))checks.push(preflightItem("ok","Contenu d’évaluation présent","Au moins une observation ou un critère a déjà été renseigné."));
    else checks.push(preflightItem("err","Aucun élément évalué","Ajoutez au moins une observation ou un critère avant l’extraction."));
    const missing=evaluationMissingFinalFields(draft);
    if(missing.length)checks.push(preflightItem("warn",`${missing.length} information${missing.length>1?"s":""} à finaliser`,missing.join(" · ")));
    else checks.push(preflightItem("ok","Informations finales renseignées","Les champs administratifs nécessaires sont déjà présents."));
  }

  checks.push(preflightItem("warn","Signature du responsable requise","La signature et la dernière confirmation seront demandées juste avant l’extraction du PDF."));
  checks.push(preflightItem("ok","Version figée après extraction","Une fois le PDF officiel créé, cette version restera intacte et un nouveau formulaire vide prendra le relais."));

  officialEl("preflight").innerHTML=checks.join("");
  officialEl("preflightPanel").hidden=false;

  const selectedDocument=OFFICIAL_DOCUMENTS.find(item=>item.key===officialEl("documentType").value)||OFFICIAL_DOCUMENTS[0];
  const continueBtn=officialEl("continueBtn");
  continueBtn.href=`${selectedDocument.route}?id=${encodeURIComponent(agent.id_agent)}`;
  continueBtn.textContent=draft?"Reprendre, finaliser puis extraire":"Commencer l’évaluation";
  continueBtn.hidden=false;

  const pdfBtn=officialEl("latestPdfBtn");
  if(latest?.url_document){
    pdfBtn.href=latest.url_document;
    pdfBtn.textContent=`Ouvrir la dernière version officielle${latest.version?` · v${latest.version}`:""}`;
    pdfBtn.hidden=false;
  }else{
    pdfBtn.hidden=true;
    pdfBtn.removeAttribute("href");
  }
}

async function loadOfficialPreflight(){
  const agent=officialState.selected;
  if(!agent)return;
  setOfficialStatus("warn","Contrôle des informations en cours…");
  try{
    const [agentData,evaluationData]=await Promise.all([
      apiGet("getAgent",{id:agent.id_agent}),
      apiGet("listEvaluations",{id:agent.id_agent})
    ]);
    const fullAgent=agentData.agent||agent;
    officialState.selected={...agent,...fullAgent};
    officialState.evaluations=evaluationData.evaluations||[];
    renderSelectedAgent(officialState.selected);
    renderEvaluationPreflight(officialState.selected,officialState.evaluations);
    clearOfficialStatus();
  }catch(error){
    officialEl("preflightPanel").hidden=true;
    setOfficialStatus("err",`Impossible de contrôler ce dossier : ${error.message}`);
  }
}

function selectOfficialAgent(id){
  const agent=officialState.agents.find(item=>String(item.id_agent)===String(id));
  if(!agent)return;
  officialState.selected=agent;
  officialEl("agentSearch").value=officialName(agent);
  renderSelectedAgent(agent);
  renderAgentResults();
  const url=new URL(location.href);
  url.searchParams.set("id",agent.id_agent);
  history.replaceState(null,"",url.pathname+url.search);
  loadOfficialPreflight();
}

async function loadOfficialAgents(){
  setOfficialStatus("warn","Chargement des agents…");
  try{
    const data=await apiGet("listAgents");
    officialState.agents=data.agents||[];
    clearOfficialStatus();
    const initialId=new URL(location.href).searchParams.get("id");
    if(initialId&&officialState.agents.some(agent=>String(agent.id_agent)===String(initialId))){
      selectOfficialAgent(initialId);
    }
  }catch(error){
    setOfficialStatus("err",`Impossible de charger les agents : ${error.message}`);
  }
}

document.addEventListener("DOMContentLoaded",async()=>{
  await GHEAuth.ready;
  officialEl("agentSearch").addEventListener("input",renderAgentResults);
  officialEl("documentType").addEventListener("change",()=>{if(officialState.selected)loadOfficialPreflight();});
  loadOfficialAgents();
});