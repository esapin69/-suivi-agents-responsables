// Vue compacte et garde-fous après validation d'une évaluation officielle.
// Chargé après evaluations.js : la logique métier serveur reste inchangée.

const evaluationCompletionOriginalResetForm = resetForm;
const evaluationCompletionOriginalFillForm = fillForm;

function evaluationCompletionShowEditor(){
  const view=el("validatedView"),form=el("evaluationForm");
  if(view)view.hidden=true;
  if(form)form.hidden=false;
}

function evaluationCompletionRender(ev){
  if(!ev)return;
  state.locked=true;
  state.currentValidatedEvaluation=ev;
  hidePreviousAnswers();
  clearValidationErrors();

  const form=el("evaluationForm"),view=el("validatedView");
  if(form)form.hidden=true;
  if(view)view.hidden=false;

  el("formKicker").textContent="Document officiel créé";
  el("formTitle").textContent="Évaluation validée";

  const meta=el("validatedMeta");
  if(meta){
    const parts=[];
    if(ev.version)parts.push(`Version ${ev.version}`);
    if(ev.date_evaluation)parts.push(displayDate(ev.date_evaluation));
    if(ev.evaluateur)parts.push(ev.evaluateur);
    meta.textContent=parts.join(" · ");
  }

  const pdf=el("validatedPdfBtn");
  if(pdf){
    if(ev.url_document){pdf.href=ev.url_document;pdf.hidden=false}
    else{pdf.removeAttribute("href");pdf.hidden=true}
  }

  const newVersion=el("validatedNewVersionBtn");
  if(newVersion)newVersion.onclick=()=>evaluationCompletionStartNewVersion(ev);
  requestAnimationFrame(()=>view?.scrollIntoView({behavior:"smooth",block:"start"}));
}

function evaluationCompletionStartNewVersion(ev){
  evaluationCompletionShowEditor();
  evaluationCompletionOriginalFillForm(ev);
  lockForm(false);
  cloneCurrentAsNewVersion();
  state.currentValidatedEvaluation=null;
  el("formKicker").textContent="Nouvelle version";
  el("formTitle").textContent="Suivi terrain";
  showFormPanel();
  requestAnimationFrame(()=>el("formPanel")?.scrollIntoView({behavior:"smooth",block:"start"}));
}

function evaluationCompletionCurrentId(){
  return String(el("evaluationForm")?.elements?.id_evaluation?.value||"").trim();
}

function evaluationCompletionCachedOfficial(id=evaluationCompletionCurrentId()){
  if(!id)return null;
  return state.evaluations.find(ev=>String(ev.id_evaluation)===id&&ev.statut==="VALIDE")||null;
}

async function evaluationCompletionRecoverOfficial(id=evaluationCompletionCurrentId()){
  const cached=evaluationCompletionCachedOfficial(id);
  if(cached){evaluationCompletionRender(cached);return true}
  if(!id)return false;
  try{
    const d=await apiGet("getEvaluation",{id});
    const ev=d?.evaluation;
    if(ev?.statut==="VALIDE"){
      upsertEvaluation(ev);
      evaluationCompletionRender(ev);
      return true;
    }
  }catch(_){ }
  return false;
}

resetForm=function(){
  evaluationCompletionShowEditor();
  state.currentValidatedEvaluation=null;
  return evaluationCompletionOriginalResetForm();
};

fillForm=function(ev){
  if(ev&&ev.statut==="VALIDE"){
    evaluationCompletionRender(ev);
    return;
  }
  evaluationCompletionShowEditor();
  state.currentValidatedEvaluation=null;
  return evaluationCompletionOriginalFillForm(ev);
};

submit=async function(finalize){
  // Sécurité n°1 : une version déjà officielle ne repart jamais vers finalizeEvaluation.
  if(finalize&&await evaluationCompletionRecoverOfficial())return;
  if(!validateForm(finalize))return;

  const button=finalize?el("finalizeBtn"):el("saveBtn"),original=button.textContent;
  setStatus(el("formStatus"),"warn",finalize?"Création du document officiel…":"Enregistrement…");
  el("saveBtn").disabled=true;
  el("finalizeBtn").disabled=true;
  button.textContent=finalize?"Création en cours…":"Enregistrement…";

  try{
    const d=await apiPost(finalize?"finalizeEvaluation":"saveEvaluationDraft",payload());
    const ev=d.evaluation;
    upsertEvaluation(ev);
    if(finalize)evaluationCompletionRender(ev);
    else{
      fillForm(ev);
      setStatus(el("formStatus"),"ok","Brouillon enregistré sans créer de doublon.");
    }
  }catch(e){
    const raw=String(e?.message||"");
    // Sécurité n°2 : si le serveur sait déjà que la version est officielle,
    // on récupère cette version et on bascule sur la vue de fin au lieu d'afficher une erreur bloquante.
    if(finalize&&raw.includes("EVALUATION_VALIDEE_IMMUABLE")&&await evaluationCompletionRecoverOfficial())return;
    setStatus(el("formStatus"),"err",esc(friendlyError(raw)));
  }finally{
    button.textContent=original;
    if(!state.locked){
      el("saveBtn").disabled=false;
      el("finalizeBtn").disabled=false;
    }
  }
};

// Sécurité n°3 : Safari/iPad peut restaurer une ancienne vue via le cache retour-arrière.
window.addEventListener("pageshow",()=>{
  requestAnimationFrame(()=>evaluationCompletionRecoverOfficial());
});
