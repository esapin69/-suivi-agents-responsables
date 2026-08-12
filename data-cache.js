(()=>{
  "use strict";

  const PREFIX="ghe:data:v2:";
  const nativeFetch=window.fetch.bind(window);

  const API_POLICIES={
    listAgents:{fresh:60_000,stale:5*60_000},
    listDirectory:{fresh:60_000,stale:5*60_000},
    getAgent:{fresh:30_000,stale:2*60_000},
    getFirstDay:{fresh:15_000,stale:60_000},
    listEvaluations:{fresh:20_000,stale:60_000},
    getEvaluation:{fresh:20_000,stale:2*60_000}
  };

  const PLANNING_POLICIES={
    list:{fresh:5*60_000,stale:30*60_000},
    ics:{fresh:2*60_000,stale:10*60_000},
    pdf_agent:{fresh:2*60_000,stale:10*60_000}
  };

  function policyFor(url,method){
    if(method!=="GET")return null;
    if(url.hostname==="responsable-api.esapin.com"){
      const action=url.searchParams.get("action")||"";
      const p=API_POLICIES[action];
      return p?{...p,scope:"api"}:null;
    }
    if(url.hostname==="script.google.com"||url.hostname==="script.googleusercontent.com"){
      const mode=url.searchParams.get("mode")||"";
      const p=PLANNING_POLICIES[mode];
      return p?{...p,scope:"planning"}:null;
    }
    return null;
  }

  function normalizedKey(url){
    const copy=new URL(url.toString());
    copy.searchParams.delete("t");
    copy.searchParams.delete("_ts");
    return PREFIX+copy.toString();
  }

  function readEntry(key){
    try{
      const raw=localStorage.getItem(key);
      if(!raw)return null;
      const parsed=JSON.parse(raw);
      if(!parsed||typeof parsed!=="object"||typeof parsed.body!=="string"||typeof parsed.time!=="number")return null;
      return parsed;
    }catch(_){return null;}
  }

  function writeEntry(key,response,body){
    try{
      const headers={};
      response.headers.forEach((v,k)=>{if(["content-type","etag","last-modified"].includes(k.toLowerCase()))headers[k]=v;});
      localStorage.setItem(key,JSON.stringify({time:Date.now(),status:response.status,statusText:response.statusText,headers,body}));
    }catch(_){pruneOldEntries();}
  }

  function cachedResponse(entry,cacheState){
    const headers=new Headers(entry.headers||{});
    headers.set("X-GHE-Client-Cache",cacheState);
    return new Response(entry.body,{status:entry.status||200,statusText:entry.statusText||"OK",headers});
  }

  async function networkAndStore(input,init,key){
    const response=await nativeFetch(input,init);
    if(response.ok){
      const clone=response.clone();
      const body=await clone.text();
      writeEntry(key,response,body);
    }
    return response;
  }

  function backgroundRefresh(input,init,key){
    networkAndStore(input,init,key).catch(()=>{});
  }

  function pruneOldEntries(){
    try{
      const now=Date.now();
      Object.keys(localStorage).filter(k=>k.startsWith(PREFIX)).forEach(k=>{
        const e=readEntry(k);
        if(!e||now-e.time>24*60*60_000)localStorage.removeItem(k);
      });
    }catch(_){}
  }

  function clearAll(){
    try{Object.keys(localStorage).filter(k=>k.startsWith(PREFIX)).forEach(k=>localStorage.removeItem(k));}catch(_){}
  }

  function clearApiForAgent(id){
    try{
      Object.keys(localStorage).filter(k=>k.startsWith(PREFIX)).forEach(k=>{
        if(k.includes("responsable-api.esapin.com")&&(!id||k.includes("id="+encodeURIComponent(id))))localStorage.removeItem(k);
      });
    }catch(_){}
  }

  window.fetch=async function(input,init={}){
    const request=input instanceof Request?input:null;
    const method=String(init.method||request?.method||"GET").toUpperCase();
    let url;
    try{url=new URL(request?request.url:String(input),location.href);}catch(_){return nativeFetch(input,init);}

    if(method!=="GET"){
      const response=await nativeFetch(input,init);
      if(response.ok&&url.hostname==="responsable-api.esapin.com"){
        const action=url.searchParams.get("action")||"";
        if(action==="login"||action==="logout")clearAll();
        else if(["createAgent","updateAgent","saveFirstDay","saveEvaluationDraft","finalizeEvaluation","submitSituation"].includes(action))clearApiForAgent();
      }
      return response;
    }

    const policy=policyFor(url,method);
    if(!policy)return nativeFetch(input,init);

    const key=normalizedKey(url);
    const entry=readEntry(key);
    const age=entry?Date.now()-entry.time:Infinity;

    if(entry&&age<policy.fresh)return cachedResponse(entry,"FRESH");
    if(entry&&age<policy.stale){
      backgroundRefresh(input,init,key);
      return cachedResponse(entry,"STALE");
    }

    try{return await networkAndStore(input,init,key);}
    catch(error){
      if(entry)return cachedResponse(entry,"FALLBACK");
      throw error;
    }
  };

  window.GHEDataCache={clearAll,clearApiForAgent,prune:pruneOldEntries};
  pruneOldEntries();
})();
