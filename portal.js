const PORTAL_MODULES = [
  {key:"suivi_des_agents",title:"Suivi des agents",desc:"Créer, retrouver et poursuivre le suivi d’un agent.",href:"Nouvelle%20agent%20et%20suivi/",icon:"◎",tone:"cyan"},
  {key:"prendre_des_notes",title:"Prendre des notes",desc:"Consigner rapidement une information terrain.",href:"https://sites.google.com/view/hfme-notes/notes-rapides",icon:"✎",tone:"ink",external:true},
  {key:"planning",title:"Planning",desc:"Planning personnel, PDF officiel et abonnement calendrier.",href:"planning.html",icon:"▦",tone:"blue"},
  {key:"esprit_d_equipe",title:"Esprit d’équipe",desc:"Vue collective, formations, stagiaires et abonnement d’équipe.",href:"esprit-equipe.html",icon:"👥",tone:"cyan"},
  {key:"contacts",title:"Contacts",desc:"Numéros, e-mails et annuaire GHE.",href:"contacts.html",icon:"☎",tone:"gold"},
  {key:"nouvel_arrivant",title:"Nouvel arrivant",desc:"Repères, attendus et parcours d’intégration.",href:"https://nouvel-agent.esapin.com/index.html",icon:"⌖",tone:"green",external:true},
  {key:"nouveau_stagiaire",title:"Nouveau stagiaire",desc:"Accueil et suivi des stagiaires.",href:"nouveau-stagiaire.html",icon:"◇",tone:"violet"}
];

const PORTAL_PLANNING_BRIDGE="https://script.google.com/macros/s/AKfycbwrhifE-4wl-YvKOjJI8HZ_g_ota7tajTKLY3jvLKEF9AvSPjIbVpqcSkSRcl5OdWV9/exec";

function cardTemplate(module){
  const external = module.external ? ' target="_blank" rel="noopener"' : '';
  const arrow = module.external ? '↗' : '→';
  return `<a class="portal-card tone-${module.tone}" href="${module.href}"${external}>
    <div class="portal-card-top"><span class="portal-icon">${module.icon}</span><span class="portal-arrow">${arrow}</span></div>
    <h2>${module.title}</h2><p>${module.desc}</p>
  </a>`;
}

function warmPortalData(){
  const tasks=[];
  if(GHEAuth.hasAccess("suivi_des_agents"))tasks.push(apiGet("listAgents"));
  if(GHEAuth.hasAccess("contacts")||GHEAuth.hasAccess("suivi_des_agents"))tasks.push(apiGet("listDirectory"));
  if(GHEAuth.hasAccess("planning")){
    const url=new URL(PORTAL_PLANNING_BRIDGE);
    url.searchParams.set("mode","list");
    tasks.push(fetch(url.toString(),{cache:"no-store"}));
  }
  tasks.forEach(task=>Promise.resolve(task).catch(()=>{}));
}

GHEAuth.ready.then(user=>{
  const name = document.getElementById("portalName");
  if(name) name.textContent = user?.prenom ? `Bonjour ${user.prenom}` : "Mon espace";
  const role = document.getElementById("portalRole");
  if(role && user?.poste) role.textContent = `${user.poste} · vos outils sont adaptés automatiquement à vos accès.`;
  const cards = document.getElementById("portalCards");
  const allowed = PORTAL_MODULES.filter(module=>GHEAuth.hasAccess(module.key));
  cards.innerHTML = allowed.map(cardTemplate).join("");
  const empty = document.getElementById("portalEmpty");
  empty.hidden = allowed.length > 0;
  setTimeout(warmPortalData,50);
});