import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("../backend/node_modules/typescript/lib/typescript.js");

function read(path) { return fs.readFileSync(path, "utf8"); }
function write(path, text) { fs.writeFileSync(path, text); }

function sourceFile(path, text) {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (sf.parseDiagnostics.length) {
    throw new Error(`${path}: syntaxe invalide: ${sf.parseDiagnostics.map(d => d.messageText).join(" | ")}`);
  }
  return sf;
}

function functionNode(path, text, name) {
  const sf = sourceFile(path, text);
  const node = sf.statements.find(statement =>
    ts.isFunctionDeclaration(statement) && statement.name && statement.name.text === name
  );
  if (!node) throw new Error(`${path}: fonction ${name} introuvable`);
  return node;
}

function replaceFunction(path, name, replacement) {
  const text = read(path);
  const node = functionNode(path, text, name);
  const next = text.slice(0, node.getStart()) + replacement.trim() + text.slice(node.end);
  sourceFile(path, next);
  write(path, next);
}

function transformFunction(path, name, transform) {
  const text = read(path);
  const node = functionNode(path, text, name);
  const original = text.slice(node.getStart(), node.end);
  const replacement = transform(original);
  if (!replacement || replacement === original) throw new Error(`${path}: aucune modification de ${name}`);
  const next = text.slice(0, node.getStart()) + replacement + text.slice(node.end);
  sourceFile(path, next);
  write(path, next);
}

function appendOnce(path, marker, code) {
  let text = read(path);
  if (text.includes(marker)) return;
  text = text.replace(/\s*$/, "\n\n") + code.trim() + "\n";
  sourceFile(path, text);
  write(path, text);
}

const codePath = "apps-script/Code.gs";
const evalPath = "apps-script/EVALUATIONS.gs";
const followPath = "apps-script/SUIVI_COMPLET.gs";
const signaturePath = "apps-script/SIGNATURES_EXTERNES.gs";

appendOnce(codePath, "function withBriefScriptLock_", `
function withBriefScriptLock_(fn, waitMs) {
  const lock = LockService.getScriptLock();
  lock.waitLock(Number(waitMs || 5000));
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}
`);

replaceFunction(codePath, "getAgent_", `
function getAgent_(id) {
  if (!id) throw new Error('ID_AGENT_MANQUANT');
  const sheet = sourceSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  const match = sheet.getRange(2, COL.ID, lastRow - 1, 1)
    .createTextFinder(String(id))
    .matchEntireCell(true)
    .useRegularExpression(false)
    .findNext();
  if (!match) return null;

  const r = sheet.getRange(match.getRow(), 1, 1, 15).getValues()[0];
  return {
    id_agent:clean_(r[COL.ID-1]), nom:clean_(r[COL.NOM-1]), prenom:clean_(r[COL.PRENOM-1]),
    telephone:clean_(r[COL.TELEPHONE-1]), matricule:clean_(r[COL.MATRICULE-1]),
    date_arrivee:formatDateForClient_(r[COL.DATE_ARRIVEE-1]),
    experiences:clean_(r[COL.EXPERIENCES-1]), verification:clean_(r[COL.VERIFICATION-1]),
    fichier_brouillon_id:clean_(r[COL.FILE_ID-1]), fichier_brouillon_url:clean_(r[COL.FILE_URL-1]),
    premier_jour_statut:clean_(r[COL.PREMIER_JOUR_STATUT-1]) || 'A_FAIRE',
    premier_jour_date:formatDateForClient_(r[COL.PREMIER_JOUR_DATE-1]),
    premier_jour_modifie_le:formatDateTimeForClient_(r[COL.PREMIER_JOUR_MODIFIE_LE-1])
  };
}
`);

replaceFunction(codePath, "fillIdentitySheet_", `
function fillIdentitySheet_(spreadsheetId, a) {
  const sh = SpreadsheetApp.openById(spreadsheetId).getSheetByName('fiche brancardier');
  if (!sh) throw new Error('ONGLET_FICHE_BRANCARDIER_MANQUANT');

  const arrival = parseIsoDate_(a.dateArrivee);
  sh.getRange('C5:C9').setValues([
    [safeSheetText_(a.nom)],
    [safeSheetText_(a.prenom)],
    [safeSheetText_(a.telephone)],
    [safeSheetText_(a.matricule)],
    [arrival || safeSheetText_(a.dateArrivee)]
  ]);
  if (arrival) sh.getRange('C9').setNumberFormat('dd/MM/yyyy');
  sh.getRange('A12').setValue(safeSheetText_(a.experiences));
}
`);

transformFunction(followPath, "saveFollowup_", original => {
  let next = original.replace(
    /\n  const lock = LockService\.getScriptLock\(\);\n  lock\.waitLock\(25000\);\n  try \{\n/,
    "\n"
  );
  next = next.replace(
    /\n  \} finally \{\n    lock\.releaseLock\(\);\n  \}\n\}$/,
    "\n}"
  );
  if (next.includes("lock.waitLock(25000)")) throw new Error("saveFollowup_: verrou global non retiré");
  return next;
});

replaceFunction(followPath, "upsertFollowupStatus_", `
function upsertFollowupStatus_(id, step, status, dateValidation, evaluator) {
  return withBriefScriptLock_(function() {
    const sh = followupStatusSheet_();
    const last = sh.getLastRow();
    const values = last >= 2 ? sh.getRange(2, 1, last - 1, 2).getDisplayValues() : [];
    const found = values.findIndex(r => clean_(r[0]) === id && normalizeFollowupStep_(r[1]) === step);
    const row = found >= 0 ? found + 2 : last + 1;
    const d = dateValidation ? parseIsoDate_(dateValidation) : '';
    sh.getRange(row, 1, 1, 6).setValues([[
      safeSheetText_(id),
      safeSheetText_(step),
      safeSheetText_(status),
      d || '',
      new Date(),
      safeSheetText_(evaluator)
    ]]);
    if (d) sh.getRange(row, 4).setNumberFormat('dd/MM/yyyy');
    try { CacheService.getScriptCache().remove(SUIVI_CONFIG.STATUS_CACHE_KEY); } catch (_) {}
  }, 5000);
}
`);

transformFunction(evalPath, "saveEvaluationDraft_", original => {
  const needle = "    const normalized=normalizeEvaluationPayload_(p,false);\n";
  if (!original.includes(needle)) throw new Error("saveEvaluationDraft_: point d'insertion introuvable");
  return original.replace(needle, needle + "    assertEvaluationNotFinalizing_(normalized.id_evaluation);\n");
});

replaceFunction(evalPath, "finalizeEvaluation_", `
function finalizeEvaluation_(p){
  const normalized=normalizeEvaluationPayload_(p,true);
  if(!hasMeaningfulEvaluation_(normalized)) throw new Error('EVALUATION_VIDE');

  const operationId=Utilities.getUuid();
  const reservation=reserveEvaluationFinalization_(normalized,operationId);
  const base=reservation.record;
  let googleDocFile=null,pdfFile=null,committed=false;

  try{
    const generated=generateOfficialEvaluation_(base);
    googleDocFile=generated.googleDocFile;
    pdfFile=generated.pdfFile;
    base.url_document=pdfFile.getUrl();
    base.sha256=sha256Hex_(pdfFile.getBlob().getBytes());

    commitEvaluationFinalization_(base,operationId);
    committed=true;

    const verified=getEvaluationById_(base.id_evaluation);
    if(!verified||verified.statut!=='VALIDE'||verified.sha256!==base.sha256||!verified.url_document){
      throw new Error('VERIFICATION_FINALISATION_ECHOUEE');
    }

    try{if(googleDocFile)googleDocFile.setTrashed(true);}catch(_){}
    return {ok:true,verified:true,message:'Évaluation validée, PDF généré et empreinte vérifiée.',evaluation:verified};
  }catch(err){
    clearEvaluationFinalizationReservation_(base&&base.id_evaluation,operationId);
    if(!committed){
      try{if(pdfFile)pdfFile.setTrashed(true);}catch(_){}
    }
    try{if(googleDocFile)googleDocFile.setTrashed(true);}catch(_){}
    throw err;
  }
}
`);

appendOnce(evalPath, "function reserveEvaluationFinalization_", `
function evaluationFinalizationReservationKey_(evaluationId){
  return 'EVAL_FINALIZE_V2_' + clean_(evaluationId);
}

function parseEvaluationFinalizationReservation_(raw){
  if(!raw) return null;
  try{
    const value=JSON.parse(raw);
    if(!value||typeof value!=='object'||!value.token||!value.id_agent||!Number(value.version)||!Number(value.started_at)) return null;
    return value;
  }catch(_){return null;}
}

function isEvaluationFinalizationReservationFresh_(value){
  return Boolean(value && Date.now()-Number(value.started_at)<3*60*1000);
}

function assertEvaluationNotFinalizing_(evaluationId){
  const id=clean_(evaluationId);
  if(!id) return;
  const props=PropertiesService.getScriptProperties();
  const key=evaluationFinalizationReservationKey_(id);
  const value=parseEvaluationFinalizationReservation_(props.getProperty(key));
  if(value&&isEvaluationFinalizationReservationFresh_(value)){
    throw new Error('EVALUATION_VERROUILLEE_FINALISATION');
  }
  if(value) props.deleteProperty(key);
}

function reserveEvaluationFinalization_(normalized,token){
  return withBriefScriptLock_(function(){
    const rows=evaluationRows_();
    const existing=normalized.id_evaluation?rows.find(x=>x.id_evaluation===normalized.id_evaluation):null;
    if(existing&&existing.statut==='VALIDE') throw new Error('EVALUATION_VALIDEE_IMMUABLE');
    if(existing&&existing.id_agent!==normalized.id_agent) throw new Error('ID_AGENT_INCOHERENT');

    const agent=requireAgent_(normalized.id_agent);
    const id=existing?existing.id_evaluation:createEvaluationId_();
    const props=PropertiesService.getScriptProperties();
    const key=evaluationFinalizationReservationKey_(id);
    const current=parseEvaluationFinalizationReservation_(props.getProperty(key));
    if(current&&isEvaluationFinalizationReservationFresh_(current)){
      throw new Error('EVALUATION_VERROUILLEE_FINALISATION');
    }

    let maxReservedVersion=0;
    const all=props.getProperties();
    Object.keys(all).forEach(propertyKey=>{
      if(propertyKey.indexOf('EVAL_FINALIZE_V2_')!==0) return;
      const reservation=parseEvaluationFinalizationReservation_(all[propertyKey]);
      if(!reservation||!isEvaluationFinalizationReservationFresh_(reservation)){
        props.deleteProperty(propertyKey);
        return;
      }
      if(reservation.id_agent===normalized.id_agent){
        maxReservedVersion=Math.max(maxReservedVersion,Number(reservation.version)||0);
      }
    });

    const version=existing
      ? existing.version
      : Math.max(nextEvaluationVersion_(rows,normalized.id_agent),maxReservedVersion+1);
    const now=new Date();
    props.setProperty(key,JSON.stringify({
      token:String(token),
      id_agent:normalized.id_agent,
      version,
      started_at:Date.now()
    }));

    return {
      record:buildEvaluationRecord_(normalized,agent,{
        id,
        statut:'VALIDE',
        version,
        createdAt:existing?existing.cree_le_raw:now,
        validatedAt:now,
        documentUrl:'',
        sha256:''
      })
    };
  },8000);
}

function commitEvaluationFinalization_(record,token){
  return withBriefScriptLock_(function(){
    const props=PropertiesService.getScriptProperties();
    const key=evaluationFinalizationReservationKey_(record.id_evaluation);
    const reservation=parseEvaluationFinalizationReservation_(props.getProperty(key));
    if(!reservation||reservation.token!==String(token)||!isEvaluationFinalizationReservationFresh_(reservation)){
      throw new Error('EVALUATION_VERROUILLEE_FINALISATION');
    }

    const sheet=evaluationSheet_();
    const rows=evaluationRows_();
    const existing=rows.find(x=>x.id_evaluation===record.id_evaluation);
    if(existing&&existing.statut==='VALIDE') throw new Error('EVALUATION_VALIDEE_IMMUABLE');
    if(existing&&existing.id_agent!==record.id_agent) throw new Error('ID_AGENT_INCOHERENT');

    const rowValues=evaluationRecordToRow_(record);
    if(existing) sheet.getRange(existing.row_number,1,1,45).setValues([rowValues]);
    else sheet.appendRow(rowValues);
    SpreadsheetApp.flush();
    props.deleteProperty(key);
  },8000);
}

function clearEvaluationFinalizationReservation_(evaluationId,token){
  const id=clean_(evaluationId);
  if(!id) return;
  try{
    withBriefScriptLock_(function(){
      const props=PropertiesService.getScriptProperties();
      const key=evaluationFinalizationReservationKey_(id);
      const current=parseEvaluationFinalizationReservation_(props.getProperty(key));
      if(current&&current.token===String(token)) props.deleteProperty(key);
    },3000);
  }catch(_){}
}
`);

transformFunction(signaturePath, "createAgentSignatureRequest_", original => {
  const needle = "  try {\n";
  if (!original.includes(needle)) throw new Error("createAgentSignatureRequest_: point d'insertion introuvable");
  return original.replace(needle, needle + "    assertEvaluationNotFinalizing_(evaluationId);\n");
});

for (const path of [codePath, evalPath, followPath, signaturePath]) {
  sourceFile(path, read(path));
}

console.log("Correctifs QA/performance appliqués et syntaxe Apps Script validée.");
