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

test('le Worker canonique expose toutes les actions métier actuelles',()=>{
  const worker=read('cloudflare/index.js');
  for(const action of [
    'getFollowup','getFollowupOverview','getAgentSignatureStatus','saveFollowup',
    'createAgentSignatureRequest','cancelAgentSignatureRequest',
    'publicGetAgentSignature','publicSubmitAgentSignature'
  ]) assert.ok(worker.includes(`"${action}"`),`action manquante: ${action}`);
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
