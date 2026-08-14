const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

function read(path){return fs.readFileSync(path,'utf8');}

function functionSource(text,name){
  const start=text.indexOf(`function ${name}(`);
  assert.notEqual(start,-1,`${name} doit exister`);
  const next=text.indexOf('\nfunction ',start+10);
  return text.slice(start,next===-1?text.length:next);
}

test('Wrangler déploie la source Cloudflare canonique',()=>{
  const config=read('backend/wrangler.jsonc');
  assert.match(config,/"main"\s*:\s*"\.\.\/cloudflare\/index\.js"/);
});

test('le backend TypeScript ne contient plus une seconde implémentation du Worker',()=>{
  const backend=read('backend/src/index.ts');
  assert.match(backend,/\.\.\/\.\.\/cloudflare\/index\.js/);
  assert.doesNotMatch(backend,/const\s+GET_ACTIONS|const\s+POST_ACTIONS|async\s+function\s+login/);
});

test('le Worker canonique expose toutes les actions métier actuelles',()=>{
  const worker=read('cloudflare/index.js');
  for(const action of [
    'getFollowup','getFollowupOverview','getAgentSignatureStatus','saveFollowup',
    'createAgentSignatureRequest','cancelAgentSignatureRequest',
    'publicGetAgentSignature','publicSubmitAgentSignature'
  ]) assert.ok(worker.includes(`"${action}"`),`action manquante: ${action}`);
});

test('le Worker canonique refuse une route protégée sans session',async()=>{
  const {default:worker}=await import('./cloudflare/index.js');
  const env={
    APPS_SCRIPT_URL:'https://script.example.test/exec',
    APPS_SCRIPT_KEY:'server-secret',
    SESSION_SECRET:'0123456789abcdef0123456789abcdef',
    LOGIN_IP_LIMITER:{limit:async()=>({success:true})},
    LOGIN_GLOBAL_LIMITER:{limit:async()=>({success:true})}
  };
  const request=new Request('https://responsable-api.esapin.com/?action=getAgent&id=A-1',{
    headers:{Origin:'https://responsable.esapin.com'}
  });
  const response=await worker.fetch(request,env,{waitUntil(){},passThroughOnException(){}});
  assert.equal(response.status,401);
  assert.equal((await response.json()).code,'AUTH_REQUISE');
});

test('le Worker canonique crée un cookie sécurisé après validation Apps Script',async()=>{
  const {default:worker}=await import('./cloudflare/index.js');
  const env={
    APPS_SCRIPT_URL:'https://script.example.test/exec',
    APPS_SCRIPT_KEY:'server-secret',
    SESSION_SECRET:'0123456789abcdef0123456789abcdef',
    LOGIN_IP_LIMITER:{limit:async()=>({success:true})},
    LOGIN_GLOBAL_LIMITER:{limit:async()=>({success:true})}
  };
  const originalFetch=global.fetch;
  let upstreamCalls=0;
  global.fetch=async()=>{
    upstreamCalls++;
    return new Response(JSON.stringify({
      ok:true,
      user:{
        id:'TEST|RESPONSABLE',nom:'TEST',prenom:'RESPONSABLE',poste:'Chef',
        display_name:'RESPONSABLE TEST',is_admin:false,access:{}
      },
      session_version:'audit-session-version-0123456789abcdef'
    }));
  };
  try{
    const request=new Request('https://responsable-api.esapin.com/?action=login',{
      method:'POST',
      headers:{Origin:'https://responsable.esapin.com','Content-Type':'application/json'},
      body:JSON.stringify({code:'123456'})
    });
    const response=await worker.fetch(request,env,{waitUntil(){},passThroughOnException(){}});
    assert.equal(response.status,200);
    const cookie=response.headers.get('Set-Cookie')||'';
    assert.match(cookie,/__Host-ghe_session=/);
    assert.match(cookie,/HttpOnly/);
    assert.match(cookie,/Secure/);
    assert.match(cookie,/SameSite=Strict/);
    assert.equal(upstreamCalls,1);
  }finally{
    global.fetch=originalFetch;
  }
});

test('la finalisation PDF ne garde plus un verrou global pendant la génération',()=>{
  const evaluations=read('apps-script/EVALUATIONS.gs');
  const source=functionSource(evaluations,'finalizeEvaluation_');
  assert.ok(source.includes('reserveEvaluationFinalization_'));
  assert.ok(source.includes('generateOfficialEvaluation_'));
  assert.ok(source.includes('commitEvaluationFinalization_'));
  assert.ok(!source.includes('waitLock(30000)'));
  assert.ok(!source.includes('LockService.getScriptLock'));
});

test('le suivi de deux agents différents ne reste pas sérialisé par un verrou global',()=>{
  const suivi=read('apps-script/SUIVI_COMPLET.gs');
  const source=functionSource(suivi,'saveFollowup_');
  assert.ok(!source.includes('waitLock(25000)'));
  assert.ok(!source.includes('LockService.getScriptLock'));
  const upsert=functionSource(suivi,'upsertFollowupStatus_');
  assert.ok(upsert.includes('withBriefScriptLock_'));
});

test('getAgent utilise une recherche ciblée au lieu de transférer toute la table',()=>{
  const code=read('apps-script/Code.gs');
  const source=functionSource(code,'getAgent_');
  assert.ok(source.includes('createTextFinder'));
  assert.ok(source.includes('matchEntireCell(true)'));
});

test('le cache client déduplique les requêtes identiques et invalide les nouvelles écritures',()=>{
  const cache=read('data-cache.js');
  assert.ok(cache.includes('const inflight=new Map()'));
  for(const action of ['saveFollowup','createAgentSignatureRequest','cancelAgentSignatureRequest']){
    assert.ok(cache.includes(`"${action}"`),`invalidation manquante: ${action}`);
  }
});
