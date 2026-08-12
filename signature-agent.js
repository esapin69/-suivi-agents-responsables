const SIGN_API='https://responsable-api.esapin.com';
const SIGN_SECTIONS=[
  ['I — Aptitude au service','observations_1',['Aptitude à travailler sans contrôle','Efficacité','Esprit pratique','Souci de perfectionnement']],
  ['II — Application dans l’exécution du travail','observations_2',["Rapidité d'exécution",'Qualité du travail',"Sens de l'organisation",'Initiative']],
  ['III — Sens du travail en commun','observations_3',['Caractère','Relation avec le personnel infirmier','Contact avec les autres agents du service','Contact avec l’encadrement']],
  ['IV — Comportement envers les malades','observations_4',['Disponibilité','Discrétion','Attitude envers les visiteurs']],
  ['V — Tenue générale, ponctualité, assiduité','observations_5',['Utilisation du temps de travail','Attitude générale','Propreté dans la tenue','Régularité','Ponctualité / assiduité']]
];
const $=id=>document.getElementById(id);
let token='';
let signed=false;
let drawing=false;
const canvas=$('signatureCanvas');
const ctx=canvas.getContext('2d');

function esc(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));}
function displayDate(value){const m=String(value||'').match(/^(\d{4})-(\d{2})-(\d{2})/);return m?`${m[3]}/${m[2]}/${m[1]}`:(value||'—');}
function levelLabel(value){return value==='Éléments insuffisants pour évaluer'?'Non observé':(value||'Non observé');}
function setStatus(message,type=''){const box=$('status');box.textContent=message;box.className='status'+(type?' '+type:'');}

function readToken(){
  const fromHash=new URLSearchParams(location.hash.replace(/^#/,'' )).get('t');
  if(fromHash){sessionStorage.setItem('ghe:external-signature-token',fromHash);history.replaceState(null,'',location.pathname);}
  return sessionStorage.getItem('ghe:external-signature-token')||'';
}

async function publicPost(action,payload){
  const url=new URL(SIGN_API+'/');url.searchParams.set('action',action);
  let response;
  try{response=await fetch(url.toString(),{method:'POST',cache:'no-store',credentials:'omit',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(payload||{})});}
  catch(_){throw new Error('Connexion impossible. Vérifiez votre réseau puis réessayez.');}
  let data;try{data=await response.json();}catch(_){throw new Error('Le service a renvoyé une réponse illisible.');}
  if(!response.ok)throw new Error(data.message||'La demande n’a pas pu être traitée.');
  return data;
}

function renderEvaluation(ev){
  $('summary').innerHTML=`
    <div><small>Agent</small><strong>${esc(ev.agent)}</strong></div>
    <div><small>Date de l’évaluation</small><strong>${esc(displayDate(ev.date_evaluation))}</strong></div>
    <div><small>Service</small><strong>${esc(ev.service||'—')}</strong></div>
    <div><small>Responsable évaluateur</small><strong>${esc(ev.evaluateur||'—')}</strong></div>`;
  const sections=SIGN_SECTIONS.map(([title,obs,criteria])=>{
    const rows=criteria.map(label=>`<div class="criterion"><span>${esc(label)}</span><span class="level">${esc(levelLabel(ev.criteres?.[label]))}</span></div>`).join('');
    const note=String(ev[obs]||'').trim();
    return `<section class="section"><h2>${esc(title)}</h2><div class="criteria">${rows}</div>${note?`<div class="observation">${esc(note)}</div>`:''}</section>`;
  }).join('');
  const general=String(ev.observations_generales||'').trim();
  $('evaluationBody').innerHTML=sections+`<section class="section"><h2>Conclusion</h2><div class="decision"><strong>Aimeriez-vous garder cet agent ? ${esc(ev.garder_agent||'—')}</strong>${general?`<div class="observation">${esc(general)}</div>`:''}<div class="observation">Fait à Lyon, le ${esc(displayDate(ev.lyon_le))}</div></div></section>`;
  $('signatureName').textContent=ev.agent?`Signature de ${ev.agent}`:'Votre signature';
}

function resizeCanvas(){
  const rect=canvas.getBoundingClientRect();if(!rect.width)return;
  const ratio=Math.max(1,window.devicePixelRatio||1),snapshot=signed?canvas.toDataURL('image/png'):'';
  canvas.width=Math.round(rect.width*ratio);canvas.height=Math.round(160*ratio);
  ctx.setTransform(ratio,0,0,ratio,0,0);ctx.lineWidth=2.4;ctx.lineCap='round';ctx.lineJoin='round';ctx.strokeStyle='#17232d';
  if(snapshot){const img=new Image();img.onload=()=>ctx.drawImage(img,0,0,rect.width,160);img.src=snapshot;}
}
function point(e){const r=canvas.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top};}
canvas.addEventListener('pointerdown',e=>{e.preventDefault();drawing=true;canvas.setPointerCapture(e.pointerId);const p=point(e);ctx.beginPath();ctx.moveTo(p.x,p.y);});
canvas.addEventListener('pointermove',e=>{if(!drawing)return;e.preventDefault();const p=point(e);ctx.lineTo(p.x,p.y);ctx.stroke();signed=true;});
canvas.addEventListener('pointerup',()=>drawing=false);canvas.addEventListener('pointercancel',()=>drawing=false);
$('clearBtn').addEventListener('click',()=>{ctx.clearRect(0,0,canvas.width,canvas.height);signed=false;});
window.addEventListener('resize',resizeCanvas);

async function submitSignature(){
  if(!signed){setStatus('Signez dans la zone prévue avant d’envoyer.','error');return;}
  if(!$('confirm').checked){setStatus('Cochez la confirmation après avoir relu l’évaluation.','error');return;}
  const button=$('submitBtn');button.disabled=true;setStatus('Enregistrement de votre signature…');
  try{
    await publicPost('publicSubmitAgentSignature',{token,signature:canvas.toDataURL('image/png')});
    sessionStorage.removeItem('ghe:external-signature-token');
    $('content').hidden=true;$('status').hidden=true;$('done').hidden=false;
  }catch(error){setStatus(error.message,'error');button.disabled=false;}
}
$('submitBtn').addEventListener('click',submitSignature);

async function init(){
  token=readToken();
  if(!token){setStatus('Ce lien de signature est incomplet ou n’est plus disponible.','error');return;}
  try{
    const data=await publicPost('publicGetAgentSignature',{token});
    if(data.request?.statut==='SIGNE'){
      sessionStorage.removeItem('ghe:external-signature-token');$('status').hidden=true;$('done').hidden=false;return;
    }
    renderEvaluation(data.evaluation||{});$('content').hidden=false;setStatus(`Lien valable jusqu’au ${displayDate(data.request?.expire_le)}.`,'ok');requestAnimationFrame(resizeCanvas);
  }catch(error){setStatus(error.message,'error');}
}
init();
