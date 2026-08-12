(()=>{
  "use strict";

  const PREFIX="ghe:data:v3:";
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

  function storageFor(policy){return policy&&policy.scope==="api"?sessionStorage:localStorage;}

  function normalizedKey(url){
    const copy=new URL(url.toString());
    copy.searchParams.delete("t");
    copy.searchParams.delete("_ts");
    return PREFIX+copy.toString();
  }

  function readEntry(storage,key){
    try{
      const raw=storage.getItem(key);
      if(!raw)return null;
      const parsed=JSON.parse(raw);
      if(!parsed||typeof parsed!=="object"||typeof parsed.body!=="string"||typeof parsed.time!=="number")return null;
      return parsed;
    }catch(_){return null;}
  }

  function writeEntry(storage,key,response,body){
    try{
      const headers={};
      response.headers.forEach((v,k)=>{if(["content-type","etag","last-modified"].includes(k.toLowerCase()))headers[k]=v;});
      storage.setItem(key,JSON.stringify({time:Date.now(),status:response.status,statusText:response.statusText,headers,body}));
    }catch(_){pruneOldEntries();}
  }

  function cachedResponse(entry,cacheState){
    const headers=new Headers(entry.headers||{});
    headers.set("X-GHE-Client-Cache",cacheState);
    return new Response(entry.body,{status:entry.status||200,statusText:entry.statusText||"OK",headers});
  }

  async function networkAndStore(input,init,storage,key){
    const response=await nativeFetch(input,init);
    if(response.ok){
      const clone=response.clone();
      const body=await clone.text();
      writeEntry(storage,key,response,body);
    }
    return response;
  }

  function backgroundRefresh(input,init,storage,key){
    networkAndStore(input,init,storage,key).catch(()=>{});
  }

  function pruneStorage(storage,maxAge){
    try{
      const now=Date.now();
      Object.keys(storage).filter(k=>k.startsWith(PREFIX)).forEach(k=>{
        const e=readEntry(storage,k);
        if(!e||now-e.time>maxAge)storage.removeItem(k);
      });
    }catch(_){}
  }

  function pruneOldEntries(){
    pruneStorage(sessionStorage,8*60*60_000);
    pruneStorage(localStorage,24*60*60_000);
  }

  function clearStorage(storage){
    try{Object.keys(storage).filter(k=>k.startsWith(PREFIX)).forEach(k=>storage.removeItem(k));}catch(_){}
  }

  function clearAll(){clearStorage(sessionStorage);clearStorage(localStorage);}

  function clearApiForAgent(id){
    try{
      Object.keys(sessionStorage).filter(k=>k.startsWith(PREFIX)).forEach(k=>{
        if(k.includes("responsable-api.esapin.com")&&(!id||k.includes("id="+encodeURIComponent(id))))sessionStorage.removeItem(k);
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

    const storage=storageFor(policy);
    const key=normalizedKey(url);
    const entry=readEntry(storage,key);
    const age=entry?Date.now()-entry.time:Infinity;

    if(entry&&age<policy.fresh)return cachedResponse(entry,"FRESH");
    if(entry&&age<policy.stale){
      backgroundRefresh(input,init,storage,key);
      return cachedResponse(entry,"STALE");
    }

    try{return await networkAndStore(input,init,storage,key);}
    catch(error){
      if(entry)return cachedResponse(entry,"FALLBACK");
      throw error;
    }
  };

  window.GHEDataCache={clearAll,clearApiForAgent,prune:pruneOldEntries};
  pruneOldEntries();
})();
