const PORTAL_MODULES = [
  {key:"suivi_des_agents",title:"Suivi des agents",desc:"Créer, retrouver et poursuivre le suivi d’un agent.",href:"Nouvelle%20agent%20et%20suivi/",icon:"◎",tone:"cyan"},
  {key:"prendre_des_notes",title:"Prendre des notes",desc:"Consigner rapidement une information terrain.",href:"https://sites.google.com/view/hfme-notes/notes-rapides",icon:"✎",tone:"ink",external:true},
  {key:"planning",title:"Planning",desc:"Consulter le planning, imprimer et s’abonner à l’agenda.",href:"planning.html",icon:"▦",tone:"blue"},
  {key:"contacts",title:"Contacts",desc:"Numéros, contacts utiles et annuaire GHE.",href:"contacts.html",icon:"☎",tone:"gold"},
  {key:"nouvel_arrivant",title:"Nouvel arrivant",desc:"Repères, attendus et parcours d’intégration.",href:"https://nouvel-agent.esapin.com/index.html",icon:"⌖",tone:"green",external:true},
  {key:"nouveau_stagiaire",title:"Nouveau stagiaire",desc:"Accueil et suivi des stagiaires.",href:"nouveau-stagiaire.html",icon:"◇",tone:"violet"}
];

function cardTemplate(module){
  const external = module.external ? ' target="_blank" rel="noopener"' : '';
  const arrow = module.external ? '↗' : '→';
  return `<a class="portal-card tone-${module.tone}" href="${module.href}"${external}>
    <div class="portal-card-top"><span class="portal-icon">${module.icon}</span><span class="portal-arrow">${arrow}</span></div>
    <h2>${module.title}</h2><p>${module.desc}</p>
  </a>`;
}

GHEAuth.ready.then(user=>{
  const name = document.getElementById("portalName");
  if(name) name.textContent = user?.prenom ? `Bonjour ${user.prenom}` : "Mon espace";
  const cards = document.getElementById("portalCards");
  const allowed = PORTAL_MODULES.filter(module=>GHEAuth.hasAccess(module.key));
  cards.innerHTML = allowed.map(cardTemplate).join("");
  const empty = document.getElementById("portalEmpty");
  empty.hidden = allowed.length > 0;
});