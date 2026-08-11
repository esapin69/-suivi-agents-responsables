const PLANNING_BRIDGE="https://script.google.com/macros/s/AKfycbwrhifE-4wl-YvKOjJI8HZ_g_ota7tajTKLY3jvLKEF9AvSPjIbVpqcSkSRcl5OdWV9/exec";
let planningAgentKey="";
let planningEvents=[];
const $=id=>document.getElementById(id);

function norm(v){return String(v||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toUpperCase().replace(/[^A-Z0-9]+/g," ").trim()}
function stableUrl(mode,extra={}){const u=new URL(PLANNING_BRIDGE);u.searchParams.set("mode",mode);Object.entries(extra).forEach(([k,v])=>u.searchParams.set(k,v));return u.toString()}
function webcal(url){return url.replace(/^https:\/\//i,"webcal://")}
function html(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]))}

function normalizeAgent(a){
  const key=a.agent||a.key||"";
  const name=a.nom||a.nomComplet||a.nom_complet||a.fullName||String(key).replace(/_/g," ");
  return {key,name};
}

async function resolveCurrentAgent(user){
  const u=new URL(PLANNING_BRIDGE);u.searchParams.set("mode","list");u.searchParams.set("t",Date.now());
  const response=await fetch(u,{cache:"no-store"});
  if(!response.ok)throw new Error("Liste des agents indisponible");
  const data=await response.json();
  const agents=Array.isArray(data?.agents)?data.agents.map(normalizeAgent):[];
  const targets=[norm(`${user.nom||""} ${user.prenom||""}`),norm(`${user.prenom||""} ${user.nom||""}`)];
  const matches=agents.filter(a=>targets.includes(norm(a.name))||targets.includes(norm(String(a.key).replace(/_/g," "))));
  if(matches.length!==1)throw new Error("Votre planning personnel n’a pas encore été associé automatiquement à ce compte.");
  return matches[0];
}

function unfoldIcs(text){return String(text||"").replace(/\r\n[ \t]/g,"").replace(/\n[ \t]/g,"")}
function parseIcsDate(raw){
  const value=String(raw||"").replace(/^.*:/,"").trim();
  const m=value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?/);
  if(!m)return null;
  return new Date(Number(m[1]),Number(m[2])-1,Number(m[3]),Number(m[4]||0),Number(m[5]||0),Number(m[6]||0));
}
function unescapeIcs(v){return String(v||"").replace(/\\n/gi," · ").replace(/\\,/g,",").replace(/\\;/g,";").replace(/\\\\/g,"\\")}
function parseIcs(text){
  const source=unfoldIcs(text);const blocks=source.split("BEGIN:VEVENT").slice(1);const events=[];
  blocks.forEach(block=>{
    const part=block.split("END:VEVENT")[0];const lines=part.split(/\r?\n/);const get=prefix=>{const l=lines.find(x=>x.startsWith(prefix));return l?l.slice(l.indexOf(":")+1):""};
    const startLine=lines.find(x=>x.startsWith("DTSTART"))||"";const endLine=lines.find(x=>x.startsWith("DTEND"))||"";
    const start=parseIcsDate(startLine),end=parseIcsDate(endLine);if(!start)return;
    events.push({start,end,summary:unescapeIcs(get("SUMMARY")),description:unescapeIcs(get("DESCRIPTION")),location:unescapeIcs(get("LOCATION"))});
  });
  return events.sort((a,b)=>a.start-b.start);
}
function fmtDate(d){return d.toLocaleDateString("fr-FR",{weekday:"long",day:"numeric",month:"long"})}
function fmtTime(d){return d?d.toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit"}):""}
function renderPlanning(){
  const now=new Date();now.setHours(0,0,0,0);
  const upcoming=planningEvents.filter(e=>e.start>=now).slice(0,70);
  const view=$("planningView");
  if(!upcoming.length){view.innerHTML='<div class="contact-note">Aucun événement futur reçu dans le flux calendrier.</div>';view.hidden=false;return}
  view.innerHTML=`<div class="native-planning-head"><div><span class="portal-eyebrow">APERÇU</span><h2>Mes prochains jours</h2></div><span>${upcoming.length} éléments</span></div><div class="native-days">${upcoming.map(e=>`<article class="native-day"><div class="native-date">${html(fmtDate(e.start))}</div><div class="native-shift"><strong>${html(e.summary||"Planning")}</strong>${e.end?`<span>${html(fmtTime(e.start))} – ${html(fmtTime(e.end))}</span>`:""}${e.location?`<small>${html(e.location)}</small>`:""}</div></article>`).join("")}</div>`;
  view.hidden=false;view.scrollIntoView({behavior:"smooth",block:"start"});
}
async function loadPlanningView(){
  const status=$("planningStatus");status.hidden=false;status.textContent="Chargement du planning…";
  try{
    const response=await fetch(stableUrl("ics",{agent:planningAgentKey}),{cache:"no-store"});const text=await response.text();
    if(!response.ok||!text.includes("BEGIN:VCALENDAR"))throw new Error("Flux calendrier indisponible");
    planningEvents=parseIcs(text);status.hidden=true;renderPlanning();
  }catch(e){status.textContent=e.message||"Planning indisponible."}
}
async function copyAndroid(){
  const url=stableUrl("ics",{agent:planningAgentKey});
  try{await navigator.clipboard.writeText(url);$("planningStatus").hidden=false;$("planningStatus").textContent="Lien permanent copié. Dans Google Agenda sur le Web : Autres agendas → + → À partir de l’URL."}
  catch(_){$("planningStatus").hidden=false;$("planningStatus").textContent=url}
}

$("officialCard").addEventListener("click",()=>{$("officialChoices").hidden=!$("officialChoices").hidden;if(!$("officialChoices").hidden)$("officialChoices").scrollIntoView({behavior:"smooth"})});
$("showPlanning").addEventListener("click",loadPlanningView);
$("printPlanning").addEventListener("click",async()=>{if($("planningView").hidden)await loadPlanningView();setTimeout(()=>window.print(),250)});
$("androidSubscribe").addEventListener("click",copyAndroid);

GHEAuth.ready.then(async user=>{
  try{
    const agent=await resolveCurrentAgent(user);planningAgentKey=agent.key;
    $("planningLead").textContent=`${agent.name} · votre planning personnel est relié à ce compte.`;
    const ics=stableUrl("ics",{agent:planningAgentKey});$("appleSubscribe").href=webcal(ics);$("personalActions").hidden=false;
  }catch(e){$("planningLead").textContent=e.message;$("planningStatus").hidden=false;$("planningStatus").textContent="Le planning officiel reste accessible ci-dessous. L’association personnelle peut être corrigée sans changer votre code."}
});