(function(){
  function personName(person){
    if(!person)return'';
    return String(person.display_name||`${person.prenom||''} ${person.nom||''}`).trim();
  }

  function setSignatureIdentity(kind,name){
    const box=document.querySelector(`.signature-pad[data-signature="${kind}"]`);
    if(!box)return;
    let line=box.querySelector('.signature-person-name');
    if(!line){
      line=document.createElement('div');
      line.className='signature-person-name';
      line.style.margin='6px 0 8px';
      line.style.fontSize='.92rem';
      line.style.fontWeight='700';
      line.style.color='#17232d';
      const title=box.querySelector('.signature-title');
      if(title)title.insertAdjacentElement('afterend',line);else box.prepend(line);
    }
    line.textContent=name?`Nom : ${name}`:'Nom : —';
  }

  async function refreshSignatureIdentities(){
    try{await GHEAuth.ready;}catch(_){}
    let agent=null;
    try{agent=await AgentContext.load();}catch(_){}
    setSignatureIdentity('agent',personName(agent));
    setSignatureIdentity('responsable',personName(GHEAuth&&GHEAuth.user));
  }

  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',refreshSignatureIdentities,{once:true});
  }else{
    refreshSignatureIdentities();
  }
})();