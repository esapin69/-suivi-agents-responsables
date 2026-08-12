// Vue compacte après validation d'une évaluation officielle.
// Chargé après evaluations.js afin de garder la logique métier existante intacte.

const evaluationCompletionOriginalResetForm = resetForm;
const evaluationCompletionOriginalFillForm = fillForm;

function evaluationCompletionShowEditor(){
  const view=el("validatedView");
  const form=el("evaluationForm");
  if(view)view.hidden=true;
  if(form)form.hidden=false;
}

function evaluationCompletionRender(ev){
  if(!ev)return;
  state.locked=true;
  state.currentValidatedEvaluation=ev;
  hidePreviousAnswers();

  const form=el("evaluationForm");
  const view=el("validatedView");
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
  // fillForm verrouille une version officielle. On déverrouille uniquement en mémoire,
  // puis la fonction existante crée une nouvelle version sans réutiliser son identifiant.
  lockForm(false);
  cloneCurrentAsNewVersion();
  state.currentValidatedEvaluation=null;
  el("formKicker").textContent="Nouvelle version";
  el("formTitle").textContent="Suivi terrain";
  showFormPanel();
  requestAnimationFrame(()=>el("formPanel")?.scrollIntoView({behavior:"smooth",block:"start"}));
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
    if(finalize){
      // Pas de rechargement, pas d'ouverture forcée d'un nouvel onglet :
      // la validation devient immédiatement une nouvelle étape visuelle.
      evaluationCompletionRender(ev);
    }else{
      fillForm(ev);
      setStatus(el("formStatus"),"ok","Brouillon enregistré sans créer de doublon.");
    }
  }catch(e){
    setStatus(el("formStatus"),"err",esc(friendlyError(e.message)));
  }finally{
    button.textContent=original;
    if(!state.locked){
      el("saveBtn").disabled=false;
      el("finalizeBtn").disabled=false;
    }
  }
};
