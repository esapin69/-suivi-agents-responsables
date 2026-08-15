(function(){
  function boot(){
    if(!window.GHEAuth)return;
    GHEAuth.ready.then(()=>{
      if(!GHEAuth.hasAccess("gestion"))return;
      document.documentElement.classList.add("gestion-v2");
      installStyle();
      tidyAndDecorate();
      const observer=new MutationObserver(()=>tidyAndDecorate());
      observer.observe(document.body,{childList:true,subtree:true});
    });
  }

  function installStyle(){
    if(document.getElementById("gheGestionV2Style"))return;
    const style=document.createElement("style");
    style.id="gheGestionV2Style";
    style.textContent=`
      .gestion-v2 .ghe-managed-wrap:has(>.portal-card),
      .gestion-v2 .ghe-managed-wrap:has(>.workspace-block),
      .gestion-v2 .ghe-managed-wrap:has(>.stage-link){display:contents!important}
      .gestion-v2 .ghe-managed-wrap:has(>.portal-card)>.ghe-context-btn,
      .gestion-v2 .ghe-managed-wrap:has(>.workspace-block)>.ghe-context-btn,
      .gestion-v2 .ghe-managed-wrap:has(>.stage-link)>.ghe-context-btn{display:none!important}
      .gestion-v2 .detail{position:relative;padding-right:48px}
      .gestion-v2 .ghe-detail-edit{position:absolute;right:8px;top:50%;transform:translateY(-50%);width:34px;height:34px;border:1px solid #c4d8e0;border-radius:10px;background:#fff;color:#087f9f;font-size:16px;font-weight:900;cursor:pointer;display:grid;place-items:center}
      .gestion-v2 .ghe-detail-edit:hover,.gestion-v2 .ghe-detail-edit:focus-visible{border-color:#14add3;outline:3px solid rgba(20,173,211,.15)}
      .gestion-v2 .ghe-inline-admin[data-v2="1"]{display:flex;gap:7px;align-items:center}
      .gestion-v2 .ghe-inline-admin[data-v2="1"] button{height:42px}
    `;
    document.head.appendChild(style);
  }

  function tidyAndDecorate(){
    removeNoiseMenus();
    decorateAgentHead();
    decorateAgentDetails();
  }

  function removeNoiseMenus(){
    document.querySelectorAll(".ghe-managed-wrap").forEach(wrap=>{
      const target=wrap.firstElementChild;
      if(!target||!target.matches(".portal-card,.workspace-block,.stage-link"))return;
      target.dataset.gheManaged="1";
      wrap.replaceWith(target);
    });
  }

  function decorateAgentHead(){
    const head=document.querySelector(".agent-head");
    if(!head)return;
    const existing=head.querySelector(".ghe-inline-admin");
    if(existing&&existing.dataset.v2!=="1")existing.remove();
    if(head.querySelector('.ghe-inline-admin[data-v2="1"]'))return;

    const tools=document.createElement("div");
    tools.className="ghe-inline-admin";
    tools.dataset.v2="1";

    const edit=document.createElement("button");
    edit.type="button";
    edit.className="ghe-admin-pencil";
    edit.textContent="✎";
    edit.setAttribute("aria-label","Modifier la fiche");
    edit.onclick=()=>window.GHEAgentAdmin?.edit?.();

    const more=document.createElement("button");
    more.type="button";
    more.className="ghe-context-btn";
    more.textContent="⋯";
    more.setAttribute("aria-label","Options de la fiche");
    more.onclick=()=>openAgentActions();

    tools.append(edit,more);
    head.appendChild(tools);
  }

  function decorateAgentDetails(){
    document.querySelectorAll('.detail[data-admin-field]:not([data-v2-admin])').forEach(detail=>{
      detail.dataset.v2Admin="1";
      const button=document.createElement("button");
      button.type="button";
      button.className="ghe-detail-edit";
      button.textContent="✎";
      button.setAttribute("aria-label","Modifier cette information");
      button.onclick=e=>{
        e.preventDefault();
        e.stopPropagation();
        window.GHEAgentAdmin?.edit?.(detail.dataset.adminField||"");
      };
      detail.appendChild(button);
    });
  }

  function openAgentActions(){
    const admin=window.GHEAgentAdmin;
    const gestion=window.GHEGestion;
    if(!admin||!gestion?.openSheet)return;
    const name=document.getElementById("name")?.textContent?.trim()||"Agent";
    const id=admin.id||new URL(location.href).searchParams.get("id")||"";
    const file=admin.fileUrl||"";
    gestion.openSheet(name,[
      {icon:"✎",label:"Modifier les informations",hint:"Nom, téléphone, matricule, arrivée, expérience",run:()=>admin.edit?.()},
      {icon:"↻",label:"Actualiser depuis la source",run:()=>admin.refresh?.()},
      id?{icon:"⧉",label:"Copier l’identifiant",run:()=>gestion.copy?.(id)}:null,
      file?{icon:"▣",label:"Ouvrir le fichier brouillon",run:()=>window.open(file,"_blank","noopener")}:null,
      {icon:"🔗",label:"Copier le lien de cette fiche",run:()=>gestion.copy?.(location.href)}
    ]);
  }

  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot,{once:true});
  else boot();
})();
