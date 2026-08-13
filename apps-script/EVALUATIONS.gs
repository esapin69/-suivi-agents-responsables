/**
 * Module Évaluations 2026 — même projet Apps Script que Code.gs.
 * Prérequis : service avancé Google Drive API activé.
 */
const EVAL_CONFIG = Object.freeze({
  SHEET_ID: '16HY5w1xUXlxNtOv2GxxYoBc86vDNMkARB0U7Lt2PDsc',
  SHEET_NAME: 'Evaluations',
  TEMPLATE_ID: '1zfWHobMvbezGEk2VeltAHyJdCr1D3MZi',
  DEST_FOLDER_ID: '1DFA9HXls1eJMBZbH2N5da74tKDcrtfFj',
  TEMPLATE_VERSION: '2026'
});

const EVAL_HEADERS = Object.freeze([
  'ID évaluation','Statut','Version','ID agent','Nom','Prénom','Matricule','Grade','Service','Dans le service depuis le','Date évaluation','Évaluateur','Créé le','Validé le','URL document officiel','Empreinte SHA-256',
  'Aptitude à travailler sans contrôle','Efficacité','Esprit pratique','Souci de perfectionnement',"Rapidité d'exécution",'Qualité du travail',"Sens de l'organisation",'Initiative','Caractère','Relation avec le personnel infirmier','Contact avec les autres agents du service','Contact avec l’encadrement','Disponibilité','Discrétion','Attitude envers les visiteurs','Utilisation du temps de travail','Attitude générale','Propreté dans la tenue','Régularité','Ponctualité / assiduité',
  'Observations I — Aptitude au service','Observations II — Exécution du travail','Observations III — Travail en commun','Observations IV — Comportement envers les malades','Observations V — Tenue, ponctualité, assiduité','Observations générales','Aimeriez-vous garder cet agent ?','Lyon, le','Version du modèle officiel'
]);
const EVAL_CRITERIA = Object.freeze(EVAL_HEADERS.slice(16,36));
const EVAL_LEVELS = Object.freeze(['Insuffisant','Médiocre','Passable','Assez bien','Bien','Très bien','Exceptionnel','Éléments insuffisants pour évaluer']);
const EVAL_NOT_OBSERVED = 'Éléments insuffisants pour évaluer';

function listEvaluations_(agentId){
  if(!agentId) throw new Error('ID_AGENT_MANQUANT');
  return evaluationRows_().filter(x=>x.id_agent===agentId).map(publicEvaluation_).sort((a,b)=>b.version-a.version);
}

function getEvaluationById_(evaluationId){
  if(!evaluationId) throw new Error('ID_EVALUATION_MANQUANT');
  const found=evaluationRows_().find(x=>x.id_evaluation===evaluationId);
  if(!found) throw new Error('EVALUATION_INTROUVABLE');
  return publicEvaluation_(found);
}

function saveEvaluationDraft_(p){
  const lock=LockService.getScriptLock(); lock.waitLock(20000);
  try{
    const normalized=normalizeEvaluationPayload_(p,false);
    assertEvaluationNotFinalizing_(normalized.id_evaluation);
    if(!hasMeaningfulEvaluation_(normalized)) throw new Error('BROUILLON_VIDE');
    const sheet=evaluationSheet_(), rows=evaluationRows_();
    const existing=normalized.id_evaluation?rows.find(x=>x.id_evaluation===normalized.id_evaluation):null;
    if(existing&&existing.statut==='VALIDE') throw new Error('EVALUATION_VALIDEE_IMMUABLE');
    if(existing&&existing.id_agent!==normalized.id_agent) throw new Error('ID_AGENT_INCOHERENT');
    const agent=requireAgent_(normalized.id_agent), now=new Date();
    const version=existing?existing.version:nextEvaluationVersion_(rows,normalized.id_agent);
    const id=existing?existing.id_evaluation:createEvaluationId_();
    const record=buildEvaluationRecord_(normalized,agent,{id,statut:'BROUILLON',version,createdAt:existing?existing.cree_le_raw:now,validatedAt:'',documentUrl:'',sha256:''});
    const rowValues=evaluationRecordToRow_(record);
    if(existing) sheet.getRange(existing.row_number,1,1,45).setValues([rowValues]); else sheet.appendRow(rowValues);
    SpreadsheetApp.flush();
    const verified=getEvaluationById_(id);
    if(!verified||verified.statut!=='BROUILLON'||verified.id_agent!==normalized.id_agent) throw new Error('VERIFICATION_BROUILLON_ECHOUEE');
    return {ok:true,verified:true,message:'Brouillon enregistré et vérifié.',evaluation:verified};
  }finally{lock.releaseLock();}
}

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

function normalizeEvaluationPayload_(p,finalizing){
  const result={
    id_evaluation:boundedText_(p.id_evaluation,100,'ID_EVALUATION_TROP_LONG'),
    id_agent:boundedText_(p.id_agent,100,'ID_AGENT_TROP_LONG'),
    grade:boundedText_(p.grade,100,'GRADE_TROP_LONG'),
    service:boundedText_(p.service,200,'SERVICE_TROP_LONG'),
    date_evaluation:clean_(p.date_evaluation),
    evaluateur:boundedText_(p.evaluateur,250,'EVALUATEUR_TROP_LONG'),
    lyon_le:clean_(p.lyon_le), garder_agent:clean_(p.garder_agent).toUpperCase(),
    observations_1:boundedText_(p.observations_1,10000,'OBSERVATION_TROP_LONGUE'),
    observations_2:boundedText_(p.observations_2,10000,'OBSERVATION_TROP_LONGUE'),
    observations_3:boundedText_(p.observations_3,10000,'OBSERVATION_TROP_LONGUE'),
    observations_4:boundedText_(p.observations_4,10000,'OBSERVATION_TROP_LONGUE'),
    observations_5:boundedText_(p.observations_5,10000,'OBSERVATION_TROP_LONGUE'),
    observations_generales:boundedText_(p.observations_generales,10000,'OBSERVATION_TROP_LONGUE'),
    criteres:(p.criteres&&typeof p.criteres==='object')?p.criteres:{},
    signatures:normalizeSignatures_(p.signatures)
  };
  if(!result.id_agent) throw new Error('ID_AGENT_MANQUANT');
  if(!result.date_evaluation||!result.evaluateur) throw new Error('CHAMPS_SUIVI_OBLIGATOIRES');
  if(!parseIsoDate_(result.date_evaluation)) throw new Error('DATE_EVALUATION_INVALIDE');
  if(result.lyon_le&&!parseIsoDate_(result.lyon_le)) throw new Error('DATE_LYON_INVALIDE');
  EVAL_CRITERIA.forEach(label=>{
    const level=clean_(result.criteres[label])||EVAL_NOT_OBSERVED;
    if(!EVAL_LEVELS.includes(level)) throw new Error('NIVEAU_INVALIDE: '+label);
    result.criteres[label]=level;
  });
  if(finalizing){
    if(!result.grade||!result.service||!result.lyon_le) throw new Error('CHAMPS_EVALUATION_OBLIGATOIRES');
    if(!['OUI','NON'].includes(result.garder_agent)) throw new Error('DECISION_GARDER_AGENT_INVALIDE');
    if(!result.signatures.responsable) throw new Error('SIGNATURE_RESPONSABLE_REQUISE');
  }else if(result.garder_agent&&!['OUI','NON'].includes(result.garder_agent)){
    throw new Error('DECISION_GARDER_AGENT_INVALIDE');
  }
  return result;
}

function hasMeaningfulEvaluation_(r){
  const observed=EVAL_CRITERIA.some(label=>clean_(r.criteres[label])&&clean_(r.criteres[label])!==EVAL_NOT_OBSERVED);
  const note=[r.observations_1,r.observations_2,r.observations_3,r.observations_4,r.observations_5,r.observations_generales].some(v=>clean_(v));
  return observed||note;
}

function normalizeSignatures_(input){
  const source=input&&typeof input==='object'?input:{},result={};
  ['agent','responsable','direction'].forEach(name=>{
    const value=clean_(source[name]); if(!value)return;
    if(!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value)) throw new Error('SIGNATURE_INVALIDE');
    if(value.length>350000) throw new Error('SIGNATURE_TROP_VOLUMINEUSE');
    result[name]=value;
  });
  return result;
}

function buildEvaluationRecord_(p,agent,meta){
  return {id_evaluation:meta.id,statut:meta.statut,version:meta.version,id_agent:agent.id_agent,nom:agent.nom,prenom:agent.prenom,matricule:agent.matricule||'',grade:p.grade,service:p.service,dans_service_depuis:agent.date_arrivee,date_evaluation:p.date_evaluation,evaluateur:p.evaluateur,cree_le_raw:meta.createdAt,valide_le_raw:meta.validatedAt,url_document:meta.documentUrl,sha256:meta.sha256,criteres:p.criteres,observations_1:p.observations_1,observations_2:p.observations_2,observations_3:p.observations_3,observations_4:p.observations_4,observations_5:p.observations_5,observations_generales:p.observations_generales,garder_agent:p.garder_agent,lyon_le:p.lyon_le,version_modele:EVAL_CONFIG.TEMPLATE_VERSION,signatures:p.signatures||{}};
}

function evaluationRecordToRow_(r){
  const values=[r.id_evaluation,r.statut,r.version,r.id_agent,r.nom,r.prenom,r.matricule,r.grade,r.service,toSheetDate_(r.dans_service_depuis),toSheetDate_(r.date_evaluation),r.evaluateur,r.cree_le_raw,r.valide_le_raw,r.url_document,r.sha256]
    .concat(EVAL_CRITERIA.map(c=>r.criteres[c]))
    .concat([r.observations_1,r.observations_2,r.observations_3,r.observations_4,r.observations_5,r.observations_generales,r.garder_agent,toSheetDate_(r.lyon_le),r.version_modele]);
  return values.map(v=>v instanceof Date||typeof v==='number'?v:safeSheetText_(v));
}

function evaluationRows_(){
  const sheet=evaluationSheet_(),last=sheet.getLastRow(); if(last<2)return[];
  return sheet.getRange(2,1,last-1,45).getValues().map((r,i)=>({
    row_number:i+2,id_evaluation:clean_(r[0]),statut:clean_(r[1]),version:Number(r[2]||0),id_agent:clean_(r[3]),nom:clean_(r[4]),prenom:clean_(r[5]),matricule:clean_(r[6]),grade:clean_(r[7]),service:clean_(r[8]),dans_service_depuis:formatDateForClient_(r[9]),date_evaluation:formatDateForClient_(r[10]),evaluateur:clean_(r[11]),cree_le_raw:r[12],valide_le_raw:r[13],cree_le:formatDateTimeForClient_(r[12]),valide_le:formatDateTimeForClient_(r[13]),url_document:clean_(r[14]),sha256:clean_(r[15]),criteres:Object.fromEntries(EVAL_CRITERIA.map((c,j)=>[c,clean_(r[16+j])||EVAL_NOT_OBSERVED])),observations_1:clean_(r[36]),observations_2:clean_(r[37]),observations_3:clean_(r[38]),observations_4:clean_(r[39]),observations_5:clean_(r[40]),observations_generales:clean_(r[41]),garder_agent:clean_(r[42]),lyon_le:formatDateForClient_(r[43]),version_modele:clean_(r[44])
  })).filter(x=>x.id_evaluation);
}

function publicEvaluation_(x){return {id_evaluation:x.id_evaluation,statut:x.statut,version:x.version,id_agent:x.id_agent,nom:x.nom,prenom:x.prenom,matricule:x.matricule,grade:x.grade,service:x.service,dans_service_depuis:x.dans_service_depuis,date_evaluation:x.date_evaluation,evaluateur:x.evaluateur,cree_le:x.cree_le,valide_le:x.valide_le,url_document:x.url_document,sha256:x.sha256,criteres:x.criteres,observations_1:x.observations_1,observations_2:x.observations_2,observations_3:x.observations_3,observations_4:x.observations_4,observations_5:x.observations_5,observations_generales:x.observations_generales,garder_agent:x.garder_agent,lyon_le:x.lyon_le,version_modele:x.version_modele};}
function requireAgent_(id){const agent=getAgent_(id);if(!agent)throw new Error('AGENT_INTROUVABLE');return agent;}
function nextEvaluationVersion_(rows,id){return rows.filter(x=>x.id_agent===id).reduce((m,x)=>Math.max(m,x.version),0)+1;}
function createEvaluationId_(){return 'EV-'+Utilities.getUuid().replace(/-/g,'').slice(0,16).toUpperCase();}
function toSheetDate_(s){return parseIsoDate_(s)||s||'';}

function evaluationSheet_(){
  const sh=SpreadsheetApp.openById(EVAL_CONFIG.SHEET_ID).getSheetByName(EVAL_CONFIG.SHEET_NAME);
  if(!sh) throw new Error('ONGLET_EVALUATIONS_MANQUANT');
  const headers=sh.getRange(1,1,1,45).getDisplayValues()[0];
  if(headers.some((h,i)=>h!==EVAL_HEADERS[i])) throw new Error('ENTETES_EVALUATIONS_INCOMPATIBLES');
  return sh;
}

function generateOfficialEvaluation_(r){
  if(typeof Drive==='undefined'||!Drive.Files) throw new Error('SERVICE_AVANCE_DRIVE_NON_ACTIVE');
  const folder=DriveApp.getFolderById(EVAL_CONFIG.DEST_FOLDER_ID);
  const safeName=(r.nom+' '+r.prenom+' - Evaluation '+displayDateFr_(r.date_evaluation)+' - v'+r.version).replace(/[\\/:*?"<>|]/g,'-');
  const copied=convertWordTemplateToGoogleDoc_(safeName),googleDocFile=DriveApp.getFileById(copied.id),doc=openConvertedDocument_(copied.id);
  fillOfficialDocument_(doc,r); doc.saveAndClose(); Utilities.sleep(1000);
  const pdfBlob=googleDocFile.getAs(MimeType.PDF).setName(safeName+'.pdf'),pdfFile=folder.createFile(pdfBlob);
  return {googleDocFile,pdfFile};
}

function elementText_(element){
  try{return element&&typeof element.getText==='function'?String(element.getText()||''):'';}catch(_){return '';}
}

function removePageBreaksInside_(container){
  if(!container||typeof container.getNumChildren!=='function') return;
  for(let i=container.getNumChildren()-1;i>=0;i--){
    const child=container.getChild(i);
    if(child.getType()===DocumentApp.ElementType.PAGE_BREAK){child.removeFromParent();continue;}
    if(typeof child.getNumChildren==='function') removePageBreaksInside_(child);
  }
}

function childContainsPageBreak_(child){
  if(!child) return false;
  if(child.getType&&child.getType()===DocumentApp.ElementType.PAGE_BREAK) return true;
  if(typeof child.getNumChildren!=='function') return false;
  for(let i=0;i<child.getNumChildren();i++) if(childContainsPageBreak_(child.getChild(i))) return true;
  return false;
}

function enforceOfficialTwoPageLayout_(doc){
  const body=doc.getBody();
  let markerIndex=-1,section4Index=-1;
  for(let i=0;i<body.getNumChildren();i++){
    const normalized=normalize_(elementText_(body.getChild(i)));
    if(markerIndex<0&&normalized.indexOf('FICHEDEVALUATION2026PAMCARDIO')>=0&&normalized.indexOf('PAGE22')>=0) markerIndex=i;
    if(section4Index<0&&normalized.indexOf('IVCOMPORTEMENTENVERSLESMALADES')>=0) section4Index=i;
  }
  if(markerIndex<0||section4Index<0||markerIndex>=section4Index) throw new Error('REPERE_PAGE_2_INTROUVABLE');

  for(let i=markerIndex+1;i<section4Index;i++) removePageBreaksInside_(body.getChild(i));

  const previous=markerIndex>0?body.getChild(markerIndex-1):null;
  if(!childContainsPageBreak_(previous)) body.insertPageBreak(markerIndex);
}

function fillOfficialDocument_(doc,r){
  setDocumentLine_(doc,'GRADE','GRADE : '+r.grade);
  setDocumentLine_(doc,'NOM','NOM : '+r.nom+' '+r.prenom+'\t\tSERVICE : '+r.service);
  setDocumentLine_(doc,'MATRICULE','MATRICULE : '+(r.matricule||''));
  setDocumentLine_(doc,'DANSLESERVICEDEPUISLE','DANS LE SERVICE DEPUIS LE : '+displayDateFr_(r.dans_service_depuis));
  const signatureDate='LYON, le '+displayDateFr_(r.lyon_le);
  if(setAllDocumentLines_(doc,'LYONLE',signatureDate)<2) throw new Error('EMPLACEMENTS_DATE_SIGNATURE_INCOMPLETS');
  replaceDateInDocument_(doc,displayDateFr_(r.date_evaluation));
  fillTableRatings_(doc.getBody(),r.criteres);
  fillObservations_(doc,[r.observations_1,r.observations_2,r.observations_3,r.observations_4,r.observations_5,r.observations_generales]);
  replaceEverywhere_(doc,/OUI\s*[☐☒]?\s*NON\s*[☐☒]?/i,r.garder_agent==='OUI'?'OUI ☒   NON ☐':'OUI ☐   NON ☒');
  insertSignatures_(doc,r.signatures||{}, {
    agent:(r.prenom+' '+r.nom).trim(),
    responsable:clean_(r.evaluateur)
  });
  enforceOfficialTwoPageLayout_(doc);
}

function walkParagraphs_(container,callback){
  if(!container||typeof container.getNumChildren!=='function') return false;
  for(let i=0;i<container.getNumChildren();i++){
    const child=container.getChild(i),type=child.getType();
    if(type===DocumentApp.ElementType.PARAGRAPH){if(callback(child.asParagraph())===true)return true;}
    else if(type===DocumentApp.ElementType.TABLE){const table=child.asTable();for(let r=0;r<table.getNumRows();r++){const row=table.getRow(r);for(let c=0;c<row.getNumCells();c++){if(walkParagraphs_(row.getCell(c),callback))return true;}}}
    else if(type===DocumentApp.ElementType.LIST_ITEM){if(callback(child.asListItem())===true)return true;}
  }
  return false;
}
function documentSections_(doc){return [doc.getBody(),doc.getHeader(),doc.getFooter()].filter(Boolean);}
function setDocumentLine_(doc,token,replacement){const wanted=normalize_(token);for(const section of documentSections_(doc)){const found=walkParagraphs_(section,p=>{if(normalize_(p.getText()).indexOf(wanted)===0){p.setText(replacement);return true;}return false;});if(found)return true;}return false;}
function setAllDocumentLines_(doc,token,replacement){const wanted=normalize_(token);let count=0;for(const section of documentSections_(doc)){walkParagraphs_(section,p=>{if(normalize_(p.getText()).indexOf(wanted)===0){p.setText(replacement);count++;}return false;});}return count;}
function replaceDateInDocument_(doc,dateText){for(const section of documentSections_(doc)){const found=walkParagraphs_(section,p=>{const text=p.getText(),normalized=normalize_(text);if(normalized.indexOf('DATE')<0)return false;if(/DATE\s*:/i.test(text)){p.setText(text.replace(/DATE\s*:[^\n\r]*/i,'DATE : '+dateText));return true;}return false;});if(found)return true;}return false;}
function fillObservations_(doc,values){let cursor=0;for(const section of documentSections_(doc)){walkParagraphs_(section,p=>{if(cursor>=values.length)return false;const label=normalize_(p.getText());if(label.indexOf('OBSERVATION')!==0)return false;const value=clean_(values[cursor++]);p.setText(label.indexOf('GENERALES')>=0?'OBSERVATIONS GENERALES :':'OBSERVATIONS :');if(value)p.appendText('\n'+value);return false;});if(cursor>=values.length)break;}}
function insertSignatures_(doc,signatures,identities){
  identities=identities||{};
  const inserted={agent:false,responsable:false,direction:false};
  documentSections_(doc).forEach(section=>walkParagraphs_(section,p=>{
    const text=normalize_(p.getText());
    if(!inserted.agent&&text.indexOf('SIGNATUREDELAGENT')>=0){
      appendSignatureIdentityAndImage_(p,signatures.agent||'','agent',identities.agent||'');
      inserted.agent=true;
    }
    if(!inserted.responsable&&(text.indexOf('SIGNATUREDURESPONSABLE')>=0||text.indexOf('RESPONSABLEEVALUATEUR')>=0)){
      appendSignatureIdentityAndImage_(p,signatures.responsable||'','responsable',identities.responsable||'');
      inserted.responsable=true;
    }
    if(!inserted.direction&&signatures.direction&&(text.indexOf('DIRECTIONDESSOINS')>=0||text.indexOf('DIRECTIONOUCHEFDESERVICE')>=0)){
      appendSignatureIdentityAndImage_(p,signatures.direction,'direction','');
      inserted.direction=true;
    }
    return false;
  }));
  if(!inserted.agent)throw new Error('EMPLACEMENT_SIGNATURE_AGENT_INTROUVABLE');
  if(signatures.responsable&&!inserted.responsable)throw new Error('EMPLACEMENT_SIGNATURE_RESPONSABLE_INTROUVABLE');
}
function appendSignatureIdentityAndImage_(container,dataUrl,name,signerName){
  const identity=clean_(signerName);
  if(identity)container.appendText('\nNom : '+identity);
  if(!dataUrl)return;
  container.appendText('\n');
  const bytes=Utilities.base64Decode(dataUrl.split(',')[1]);
  const image=container.appendInlineImage(Utilities.newBlob(bytes,'image/png','signature-'+name+'.png'));
  const width=145,height=Math.max(42,Math.round(image.getHeight()*width/image.getWidth()));
  image.setWidth(width).setHeight(Math.min(height,72));
}
function fillTableRatings_(body,criteria){body.getTables().forEach(table=>{for(let i=0;i<table.getNumRows();i++){const row=table.getRow(i);for(let j=0;j<row.getNumCells();j++){const label=clean_(row.getCell(j).getText()),criterion=EVAL_CRITERIA.find(c=>normalize_(c)===normalize_(label));if(!criterion)continue;const selected=EVAL_LEVELS.indexOf(criteria[criterion]);for(let k=0;k<EVAL_LEVELS.length&&j+1+k<row.getNumCells();k++)row.getCell(j+1+k).setText(k===selected?'X':'');}}});}
function replaceEverywhere_(doc,regex,replacement){const pattern=regex.source,safe=String(replacement).replace(/\$/g,'$$$$');documentSections_(doc).forEach(section=>{try{section.replaceText(pattern,safe);}catch(_){}});}
function sha256Hex_(bytes){return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,bytes).map(b=>('0'+((b<0?b+256:b).toString(16))).slice(-2)).join('');}
function openConvertedDocument_(fileId){let lastError;for(let attempt=0;attempt<6;attempt++){if(attempt)Utilities.sleep(1000*attempt);try{return DocumentApp.openById(fileId);}catch(err){lastError=err;}}throw new Error('DOCUMENT_CONVERTI_INACCESSIBLE: '+String(lastError&&lastError.message||lastError));}
function convertWordTemplateToGoogleDoc_(name){const template=DriveApp.getFileById(EVAL_CONFIG.TEMPLATE_ID);try{return Drive.Files.create({name,mimeType:'application/vnd.google-apps.document',parents:[EVAL_CONFIG.DEST_FOLDER_ID]},template.getBlob(),{fields:'id,name,mimeType'});}catch(err){throw new Error('CONVERSION_MODELE_WORD_ECHOUEE: '+String(err&&err.message||err));}}
function testEvaluationConfiguration(){const sh=evaluationSheet_(),template=DriveApp.getFileById(EVAL_CONFIG.TEMPLATE_ID);DriveApp.getFolderById(EVAL_CONFIG.DEST_FOLDER_ID).getName();if(typeof Drive==='undefined'||!Drive.Files)throw new Error('Activez le service avancé Google Drive API.');const copy=convertWordTemplateToGoogleDoc_('TEST AUTORISATION - à supprimer');try{const copiedDoc=openConvertedDocument_(copy.id);copiedDoc.getBody().getText();copiedDoc.saveAndClose();}finally{DriveApp.getFileById(copy.id).setTrashed(true);}console.log(JSON.stringify({ok:true,sheet:sh.getName(),columns:sh.getLastColumn(),source:template.getName(),template:EVAL_CONFIG.TEMPLATE_VERSION}));}

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
