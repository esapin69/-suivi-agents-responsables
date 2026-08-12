(()=>{
  let panel=null,currentLink='',pollTimer=null,lastEvaluationId='',activeStatus='AUCUNE';

  function currentId(){return String(document.getElementById('evaluationForm')?.elements?.id_evaluation?.value||'').trim();}
  function formatDateTime(value){if(!value)return'';const d=new Date(value);return Number.isNaN(d.getTime())?String(value):new Intl.DateTimeFormat('fr-FR',{dateStyle:'short',timeStyle:'short'}).format(d);}

  function installStyle(){
    if(document.getElementById('externalSignatureStyle'))return;
    const style=document.createElement('style');style.id='externalSignatureStyle';style.textContent=`
      .external-signature-panel{margin:18px 0;padding:16px;border:1px solid #cbdde4;border-radius:17px;background:#f6fafb}.external-signature-panel h4{margin:0 0 6px;font-size:16px}.external-signature-panel p{margin:0;color:#607680;font-size:13px;line-height:1.42}.external-signature-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.external-signature-state{margin-top:11px;padding:10px 12px;border-radius:12px;background:#eaf2f5;font-size:12px;font-weight:800}.external-signature-state.wait{background:#fff7e7;color:#8a6014}.external-signature-state.signed{background:#eaf8ef;color:#176f3a}.external-signature-state.error{background:#fff0f0;color:#a32b2b}.evaluation-form.external-signature-locked input:not(#confirmFinal),.evaluation-form.external-signature-locked textarea,.evaluation-form.external-signature-locked select{pointer-events:none;caret-color:transparent}.evaluation-form.external-signature-locked .level-options,.evaluation-form.external-signature-locked .keep-agent{pointer-events:none}.signature-pad.remote-agent-signature{opacity:.72}.signature-pad.remote-agent-signature canvas,.signature-pad.remote-agent-signature .signature-clear{pointer-events:none}.signature-pad.remote-agent-signature .signature-title span{display:none}.signature-pad.remote-agent-signature .signature-title::after{content:'Signature demandée par SMS';font-size:11px;font-weight:800;color:#168eb5}`;document.head.appendChild(style);
  }

  function ensurePanel(){
    if(panel)return panel;
    const grid=document.querySelector('.signature-grid');if(!grid)return null;
    panel=document.createElement('div');panel.className='external-signature-panel';panel.innerHTML=`
      <h4>Signature de l’agent à distance</h4>
      <p>Envoyez un lien personnel par SMS. L’agent relit cette évaluation puis signe directement sur son téléphone.</p>
      <div class="external-signature-actions">
        <button type="button" class="btn light" id="externalSignatureRequest">Demander la signature par SMS</button>
        <a class="btn cyan" id="externalSignatureSms" href="#" hidden>Ouvrir le SMS</a>
        <button type="button" class="btn light" id="externalSignatureCopy" hidden>Copier le lien</button>
        <button type="button" class="btn light" id="externalSignatureRefresh" hidden>Actualiser</button>
        <button type="button" class="btn light" id="externalSignatureCancel" hidden>Annuler la demande</button>
      </div>
      <div class="external-signature-state" id="externalSignatureState">Aucune demande envoyée.</div>`;
    grid.before(panel);
    document.getElementById('externalSignatureRequest').addEventListener('click',requestSignature);
    document.getElementById('externalSignatureCopy').addEventListener('click',copyLink);
    document.getElementById('externalSignatureRefresh').addEventListener('click',()=>refreshStatus(true));
    document.getElementById('externalSignatureCancel').addEventListener('click',cancelRequest);
    return panel;
  }

  function setState(text,type=''){const box=document.getElementById('externalSignatureState');if(!box)return;box.textContent=text;box.className='external-signature-state'+(type?' '+type:'');}
  function buttons(){return{request:document.getElementById('externalSignatureRequest'),sms:document.getElementById('externalSignatureSms'),copy:document.getElementById('externalSignatureCopy'),refresh:document.getElementById('externalSignatureRefresh'),cancel:document.getElementById('externalSignatureCancel')};}

  function applyLock(status){
    const form=document.getElementById('evaluationForm'),agentPad=document.querySelector('[data-signature="agent"]');if(!form)return;
    const locked=status==='EN_ATTENTE'||status==='SIGNE';form.classList.toggle('external-signature-locked',locked);agentPad?.classList.toggle('remote-agent-signature',locked);
    const save=document.getElementById('saveBtn'),finalize=document.getElementById('finalizeBtn');
    if(save)save.hidden=locked;
    if(finalize&&locked)finalize.disabled=status!=='SIGNE';
    if(finalize&&!locked&&typeof state!=='undefined'&&!state.locked)finalize.disabled=false;
  }

  function stopPolling(){if(pollTimer){clearInterval(pollTimer);pollTimer=null;}}
  function startPolling(){stopPolling();pollTimer=setInterval(()=>{if(!document.hidden)refreshStatus(false);},15000);}

  function applyStatus(request){
    ensurePanel();const status=request?.statut||'AUCUNE',b=buttons();activeStatus=status;applyLock(status);
    b.sms.hidden=!currentLink;b.copy.hidden=!currentLink;b.refresh.hidden=!(status==='EN_ATTENTE'||status==='SIGNE');b.cancel.hidden=!(status==='EN_ATTENTE'||status==='SIGNE');
    if(status==='AUCUNE'||status==='ANNULE'||status==='EXPIRE'){
      b.request.hidden=false;b.request.textContent='Demander la signature par SMS';setState(status==='EXPIRE'?'Le précédent lien a expiré. Vous pouvez en créer un nouveau.':'Aucune demande de signature active.');stopPolling();return;
    }
    if(status==='EN_ATTENTE'){
      b.request.hidden=false;b.request.textContent=currentLink?'Générer un nouveau lien':'Renvoyer avec un nouveau lien';setState(`En attente de la signature de l’agent${request.expire_le?' · lien valable jusqu’au '+formatDateTime(request.expire_le):''}.`,'wait');startPolling();return;
    }
    if(status==='SIGNE'){
      b.request.hidden=true;b.sms.hidden=true;b.copy.hidden=true;setState(`Signature reçue${request.signe_le?' le '+formatDateTime(request.signe_le):''}. Elle sera intégrée automatiquement au PDF officiel.`,'signed');stopPolling();return;
    }
    if(status==='FINALISE'){
      b.request.hidden=true;b.sms.hidden=true;b.copy.hidden=true;b.refresh.hidden=true;b.cancel.hidden=true;setState('Signature de l’agent intégrée à la version officielle.','signed');stopPolling();
    }
  }

  async function refreshStatus(showLoading=false){
    ensurePanel();const id=currentId();if(!id){currentLink='';applyStatus({statut:'AUCUNE'});return;}
    if(showLoading)setState('Vérification de la signature…');
    try{const data=await apiGet('getAgentSignatureStatus',{id});applyStatus(data.request||{statut:'AUCUNE'});}
    catch(error){setState(error.message||'Impossible de vérifier la signature.','error');}
  }

  async function createLinkForEvaluation(evaluationId){
    const created=await apiPost('createAgentSignatureRequest',{id_evaluation:evaluationId});
    currentLink=created.request?.signature_url||'';
    if(!currentLink)throw new Error('Le lien de signature n’a pas été créé.');
    const agentData=await apiGet('getAgent',{id:AgentContext.id}).catch(()=>({agent:null}));
    configureSms(currentLink,agentData.agent||null);
    applyStatus(created.request||{statut:'EN_ATTENTE'});
    setState('Lien sécurisé prêt. Ouvrez le SMS puis envoyez-le à l’agent.','wait');
  }

  async function requestSignature(){
    ensurePanel();const button=buttons().request;button.disabled=true;
    try{
      if(activeStatus==='EN_ATTENTE'){
        const id=currentId();if(!id)throw new Error('Évaluation introuvable.');
        setState('Création d’un nouveau lien sécurisé…');
        await createLinkForEvaluation(id);
        return;
      }
      if(typeof validateForm==='function'&&!validateForm(false))return;
      setState('Enregistrement de l’évaluation avant envoi…');
      const saved=await apiPost('saveEvaluationDraft',payload());
      const ev=saved.evaluation;if(!ev?.id_evaluation)throw new Error('Le brouillon n’a pas reçu d’identifiant.');
      if(typeof upsertEvaluation==='function')upsertEvaluation(ev);
      if(typeof fillForm==='function')fillForm(ev);
      await createLinkForEvaluation(ev.id_evaluation);
    }catch(error){setState(error.message||'Impossible de créer la demande de signature.','error');}
    finally{button.disabled=false;}
  }

  function configureSms(link,agent){
    const a=buttons().sms,phone=String(agent?.telephone||'').replace(/[^+0-9]/g,''),name=String(agent?.prenom||'').trim();
    const body=`Bonjour${name?' '+name:''}, peux-tu relire et signer ton évaluation via ce lien sécurisé : ${link}`;
    if(!phone){a.hidden=true;return;}
    const separator=/iPad|iPhone|iPod/i.test(navigator.userAgent)?'&':'?';a.href=`sms:${encodeURIComponent(phone)}${separator}body=${encodeURIComponent(body)}`;a.hidden=false;
  }

  async function copyLink(){if(!currentLink)return;try{await navigator.clipboard.writeText(currentLink);setState('Lien copié.','signed');}catch(_){setState('Impossible de copier automatiquement le lien.','error');}}

  async function cancelRequest(){
    const id=currentId();if(!id)return;
    const message='Annuler cette demande ? Si la signature a déjà été reçue, elle sera invalidée et l’évaluation redeviendra modifiable.';
    if(!window.confirm(message))return;
    setState('Annulation…');
    try{const data=await apiPost('cancelAgentSignatureRequest',{id_evaluation:id});currentLink='';applyStatus(data.request||{statut:'ANNULE'});setState('Demande annulée. L’évaluation peut de nouveau être modifiée.');}
    catch(error){setState(error.message||'Impossible d’annuler la demande.','error');}
  }

  function watchEvaluation(){
    const title=document.getElementById('formTitle');if(!title)return;
    const sync=()=>{const id=currentId();if(id===lastEvaluationId)return;lastEvaluationId=id;currentLink='';activeStatus='AUCUNE';setTimeout(()=>refreshStatus(false),0);};
    new MutationObserver(sync).observe(title,{childList:true,subtree:true,characterData:true});
    document.getElementById('newBtn')?.addEventListener('click',()=>{lastEvaluationId='';currentLink='';activeStatus='AUCUNE';setTimeout(()=>applyStatus({statut:'AUCUNE'}),0);});
    sync();
  }

  document.addEventListener('DOMContentLoaded',()=>{installStyle();ensurePanel();watchEvaluation();document.addEventListener('visibilitychange',()=>{if(!document.hidden&&currentId())refreshStatus(false);});});
})();
