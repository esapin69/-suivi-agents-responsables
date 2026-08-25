// Cycle d’évaluation : brouillon progressif -> extraction officielle figée -> nouveau brouillon vide.
// Chargé après evaluations.js : on conserve le moteur existant et on renforce uniquement le cycle métier.

const evaluationCompletionOriginalResetForm = resetForm;
const evaluationCompletionOriginalFillForm = fillForm;
const evaluationCompletionOriginalValidateForm = validateForm;

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

  el("formKicker").textContent="Document officiel figé";
  el("formTitle").textContent="Évaluation extraite";

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
  if(newVersion)newVersion.onclick=evaluationCompletionStartBlankEvaluation;
  requestAnimationFrame(()=>view?.scrollIntoView({behavior:"smooth",block:"start"}));
}

function evaluationCompletionStartBlankEvaluation(){
  evaluationCompletionShowEditor();
  evaluationCompletionOriginalResetForm();
  state.currentValidatedEvaluation=null;
  el("formKicker").textContent="Nouvelle évaluation";
  el("formTitle").textContent="Suivi terrain";
  setStatus(el("formStatus"),"ok","Nouveau formulaire vide prêt. Les versions officielles précédentes restent intactes.");
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

function evaluationCompletionDraftTarget(name){
  const control=el("evaluationForm")?.elements?.[name];
  if(!control)return el("evaluationForm");
  const input=control.length&&!control.tagName?control[0]:control;
  return validationTarget(input);
}

function evaluationCompletionMarkDraftProblem(name,label,missing){
  const target=evaluationCompletionDraftTarget(name);
  target?.classList?.add("validation-error");
  missing.push({label,target});
}

// Un brouillon est volontairement progressif : il peut être enregistré depuis n’importe quelle rubrique.
// Les contrôles complets ne sont appliqués qu’au moment de l’extraction officielle.
validateForm=function(finalize){
  if(finalize)return evaluationCompletionOriginalValidateForm(true);

  clearValidationErrors();
  const data=payload(),missing=[];
  if(!String(data.date_evaluation||"").trim())evaluationCompletionMarkDraftProblem("date_evaluation","Date de l’évaluation",missing);
  if(!String(data.evaluateur||"").trim())evaluationCompletionMarkDraftProblem("evaluateur","Responsable évaluateur",missing);
  if(!hasMeaningfulContent(data))missing.push({label:"au moins une observation ou un critère réellement renseigné",target:el("criteria")});

  if(!missing.length)return true;
  setStatus(el("formStatus"),"err",`Impossible d’enregistrer : ${missing.map(item=>item.label).join(" · ")}.`);
  missing[0].target?.scrollIntoView?.({behavior:"smooth",block:"center"});
  return false;
};

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

function evaluationCompletionResetAfterExtraction(ev){
  const pdfUrl=String(ev?.url_document||"");
  evaluationCompletionShowEditor();
  evaluationCompletionOriginalResetForm();
  state.currentValidatedEvaluation=null;
  state.locked=false;

  const form=el("evaluationForm");
  form?.classList?.remove("external-signature-locked");
  document.querySelector('[data-signature="agent"]')?.classList?.remove("remote-agent-signature");

  el("formKicker").textContent="Nouvelle évaluation";
  el("formTitle").textContent="Suivi terrain";

  const pdf=el("pdfBtn");
  if(pdfUrl&&pdf){
    pdf.href=pdfUrl;
    pdf.textContent="Ouvrir le PDF qui vient d’être extrait";
    pdf.hidden=false;
  }

  setStatus(el("formStatus"),"ok","Évaluation extraite et figée. Le formulaire de travail a été remis à zéro pour la prochaine évaluation.");
  showFormPanel();
  requestAnimationFrame(()=>el("formPanel")?.scrollIntoView({behavior:"smooth",block:"start"}));
}

submit=async function(finalize){
  // Une version déjà officielle ne repart jamais vers finalizeEvaluation.
  if(finalize&&await evaluationCompletionRecoverOfficial())return;
  if(!validateForm(finalize))return;

  const button=finalize?el("finalizeBtn"):el("saveBtn"),original=button.textContent;
  setStatus(el("formStatus"),"warn",finalize?"Extraction et verrouillage du document officiel…":"Enregistrement du brouillon…");
  el("saveBtn").disabled=true;
  el("finalizeBtn").disabled=true;
  button.textContent=finalize?"Extraction en cours…":"Enregistrement…";

  try{
    const d=await apiPost(finalize?"finalizeEvaluation":"saveEvaluationDraft",payload());
    const ev=d.evaluation;
    upsertEvaluation(ev);

    if(finalize){
      evaluationCompletionResetAfterExtraction(ev);
    }else{
      fillForm(ev);
      setStatus(el("formStatus"),"ok","Brouillon enregistré. Vous pouvez revenir le compléter ou le modifier plus tard.");
    }
  }catch(e){
    const raw=String(e?.message||"");
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

function evaluationCompletionEnableProgressiveDrafts(){
  const form=el("evaluationForm");
  if(form)form.noValidate=true;
  const save=el("saveBtn");
  if(save)save.setAttribute("formnovalidate","");
}

document.addEventListener("DOMContentLoaded",evaluationCompletionEnableProgressiveDrafts);

// Safari/iPad peut restaurer une ancienne vue via le cache retour-arrière.
window.addEventListener("pageshow",()=>{
  requestAnimationFrame(()=>evaluationCompletionRecoverOfficial());
});
