const CONTACT_SOURCE="https://raw.githubusercontent.com/esapin69/planning/main/contacts-ghe.html";
const CONTACT_EMAILS={};
let CONTACTS=[];
const $=id=>document.getElementById(id);
function clean(v){return String(v??"").trim()}
function norm(v){return clean(v).normalize("NFD").replace(/[\u0300-\u036f]/g,"").toUpperCase()}
function html(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]))}
function digits(v){return String(v||"").replace(/\D/g,"")}
function formatPhone(v){const d=digits(v);return d.length===10?d.replace(/(\d{2})(?=\d)/g,"$1 ").trim():clean(v)}
function gheNum(v){const m=String(v||"").match(/\d+/);return m?Number(m[0]):9999}
function normalizeContact(c){const key=clean(c.agent_key)||norm(`${c.nom}_${c.prenom}`).replace(/\s+/g,"_");return{nom:clean(c.nom),prenom:clean(c.prenom),ghe:clean(c.ghe),telephone:clean(c.telephone),email:clean(c.email||CONTACT_EMAILS[key]),agent_key:key}}
function extractDirectory(text){
  const marker="const DIRECTORY_FALLBACK=";const start=text.indexOf(marker);if(start<0)throw new Error("Annuaire source introuvable");
  const arrayStart=text.indexOf("[",start);const endMarker=text.indexOf("\n];",arrayStart);if(arrayStart<0||endMarker<0)throw new Error("Format d’annuaire invalide");
  const raw=text.slice(arrayStart,endMarker+2);const parsed=JSON.parse(raw);return parsed.map(normalizeContact).filter(c=>c.nom&&c.prenom);
}
function render(){
  const q=norm($("contactSearch").value);const list=$("contactList");
  const shown=CONTACTS.filter(c=>!q||norm(`${c.nom} ${c.prenom} ${c.ghe} ${c.telephone} ${c.email}`).includes(q));
  if(!shown.length){list.innerHTML='<div class="contact-note">Aucun contact trouvé.</div>';return}
  list.innerHTML=shown.map(c=>{
    const tel=digits(c.telephone);const phone=tel.length===10?`<a href="tel:${tel}" aria-label="Appeler ${html(c.prenom)} ${html(c.nom)}">☎ ${html(formatPhone(c.telephone))}</a>`:`<span>${html(c.telephone||"Numéro non renseigné")}</span>`;
    const mail=c.email?`<a href="mailto:${html(c.email)}">✉ E-mail</a>`:`<span class="contact-missing">E-mail non renseigné</span>`;
    return `<article class="contact-item"><div><strong>${html(c.prenom)} ${html(c.nom)}</strong><small>${html(c.ghe||"GHE non renseigné")}</small></div><div class="contact-actions">${phone}${mail}</div></article>`
  }).join("");
}
async function loadContacts(){
  const status=$("contactStatus");
  try{
    const response=await fetch(CONTACT_SOURCE,{cache:"no-store"});if(!response.ok)throw new Error("HTTP "+response.status);
    CONTACTS=extractDirectory(await response.text()).sort((a,b)=>gheNum(a.ghe)-gheNum(b.ghe)||a.nom.localeCompare(b.nom,"fr"));
    status.textContent=`${CONTACTS.length} contacts chargés. Les e-mails apparaissent dès qu’ils sont renseignés dans la source complémentaire.`;
    render();
  }catch(e){status.textContent="Impossible de charger l’annuaire pour le moment."}
}
$("contactSearch").addEventListener("input",render);
GHEAuth.ready.then(loadContacts);