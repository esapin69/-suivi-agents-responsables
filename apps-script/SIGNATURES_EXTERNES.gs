/**
 * SIGNATURES_EXTERNES.gs
 * Signature distante de l'agent pour une évaluation officielle.
 * Même projet Apps Script que Code.gs, EVALUATIONS.gs et SUIVI_COMPLET.gs.
 *
 * Sécurité :
 * - le jeton brut n'est jamais stocké, seulement son SHA-256 ;
 * - le lien expire après 7 jours ;
 * - le contenu de l'évaluation est figé par une empreinte SHA-256 ;
 * - une demande en attente ou signée verrouille le brouillon ;
 * - la signature PNG est stockée dans Drive, pas dans une cellule Sheets ;
 * - une demande annulée invalide immédiatement le lien et sa signature éventuelle.
 */
const EXTERNAL_SIGNATURE_CONFIG = Object.freeze({
  SHEET_NAME: 'Signatures externes',
  EXPIRY_DAYS: 7,
  SIGNATURE_FOLDER_NAME: '_Signatures temporaires système',
  PUBLIC_URL: 'https://responsable.esapin.com/signature-agent.html'
});

const EXTERNAL_SIGNATURE_HEADERS = Object.freeze([
  'ID demande','ID évaluation','ID agent','Token SHA-256','Statut',
  'Empreinte contenu','Créé le','Expire le','Signé le','ID fichier signature',
  'SHA-256 signature','Demandeur','Annulé le','Finalisé le'
]);

function createAgentSignatureRequest_(p, principal) {
  const evaluationId = boundedText_(p && p.id_evaluation, 100, 'ID_EVALUATION_TROP_LONG');
  if (!evaluationId) throw new Error('ID_EVALUATION_MANQUANT');

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ev = externalSignatureEvaluation_(evaluationId);
    if (ev.statut !== 'BROUILLON') throw new Error('EVALUATION_DEJA_OFFICIELLE');
    assertEvaluationReadyForExternalSignature_(ev);

    const current = latestExternalSignatureRequest_(evaluationId);
    if (current && current.statut === 'SIGNE') {
      throw new Error('SIGNATURE_AGENT_DEJA_RECUE');
    }
    if (current && current.statut === 'FINALISE') {
      throw new Error('EVALUATION_DEJA_OFFICIELLE');
    }
    if (current && current.statut === 'EN_ATTENTE') {
      updateExternalSignatureRequest_(current.row_number, {statut:'ANNULE', annule_le:new Date()});
    }

    const token = createExternalSignatureToken_();
    const now = new Date();
    const expires = new Date(now.getTime() + EXTERNAL_SIGNATURE_CONFIG.EXPIRY_DAYS * 86400000);
    const requestId = 'SIG-' + Utilities.getUuid().replace(/-/g, '').slice(0, 16).toUpperCase();
    const requester = principal ? clean_(principal.prenom + ' ' + principal.nom) : clean_(p.demandeur);
    const sheet = externalSignatureSheet_();
    sheet.appendRow([
      requestId,
      ev.id_evaluation,
      ev.id_agent,
      externalSignatureHashText_(token),
      'EN_ATTENTE',
      evaluationSnapshotHash_(ev),
      now,
      expires,
      '',
      '',
      '',
      safeSheetText_(requester),
      '',
      ''
    ]);
    SpreadsheetApp.flush();

    return {
      ok: true,
      request: {
        id_demande: requestId,
        id_evaluation: ev.id_evaluation,
        statut: 'EN_ATTENTE',
        expire_le: formatDateTimeForClient_(expires),
        signature_url: EXTERNAL_SIGNATURE_CONFIG.PUBLIC_URL + '#t=' + encodeURIComponent(token)
      }
    };
  } finally {
    lock.releaseLock();
  }
}

function getAgentSignatureStatus_(evaluationId) {
  const id = boundedText_(evaluationId, 100, 'ID_EVALUATION_TROP_LONG');
  if (!id) throw new Error('ID_EVALUATION_MANQUANT');
  const current = latestExternalSignatureRequest_(id);
  if (!current) return {id_evaluation:id, statut:'AUCUNE'};
  expireExternalSignatureRequestIfNeeded_(current);
  const refreshed = latestExternalSignatureRequest_(id) || current;
  return publicExternalSignatureStatus_(refreshed);
}

function cancelAgentSignatureRequest_(p) {
  const evaluationId = boundedText_(p && p.id_evaluation, 100, 'ID_EVALUATION_TROP_LONG');
  if (!evaluationId) throw new Error('ID_EVALUATION_MANQUANT');
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const current = latestExternalSignatureRequest_(evaluationId);
    if (!current || ['ANNULE','EXPIRE'].includes(current.statut)) {
      return {ok:true, request:{id_evaluation:evaluationId, statut:'AUCUNE'}};
    }
    if (current.statut === 'FINALISE') throw new Error('EVALUATION_DEJA_OFFICIELLE');
    trashExternalSignatureFile_(current.id_fichier_signature);
    updateExternalSignatureRequest_(current.row_number, {
      statut:'ANNULE', annule_le:new Date(), id_fichier_signature:'', sha256_signature:''
    });
    SpreadsheetApp.flush();
    return {ok:true, request:{id_evaluation:evaluationId, statut:'ANNULE'}};
  } finally {
    lock.releaseLock();
  }
}

function publicGetAgentSignature_(p) {
  const request = requireExternalSignatureByToken_(p && p.token, false);
  const ev = externalSignatureEvaluation_(request.id_evaluation);
  assertExternalSignatureSnapshot_(request, ev);
  return {
    ok:true,
    request:{
      statut:request.statut,
      expire_le:formatDateTimeForClient_(request.expire_le),
      signe_le:formatDateTimeForClient_(request.signe_le)
    },
    evaluation:publicExternalEvaluation_(ev)
  };
}

function publicSubmitAgentSignature_(p) {
  const token = clean_(p && p.token);
  const signature = normalizeExternalSignaturePng_(p && p.signature);
  if (!signature) throw new Error('SIGNATURE_AGENT_REQUISE');

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const request = requireExternalSignatureByToken_(token, true);
    if (request.statut === 'SIGNE') {
      return {ok:true, already_signed:true, signe_le:formatDateTimeForClient_(request.signe_le)};
    }
    if (request.statut !== 'EN_ATTENTE') throw new Error('LIEN_SIGNATURE_INVALIDE');

    const ev = externalSignatureEvaluation_(request.id_evaluation);
    assertExternalSignatureSnapshot_(request, ev);
    const saved = saveExternalSignatureFile_(request.id_demande, signature);
    const now = new Date();
    updateExternalSignatureRequest_(request.row_number, {
      statut:'SIGNE',
      signe_le:now,
      id_fichier_signature:saved.file.getId(),
      sha256_signature:saved.sha256
    });
    SpreadsheetApp.flush();
    return {
      ok:true,
      signe_le:formatDateTimeForClient_(now),
      agent:(ev.prenom + ' ' + ev.nom).trim()
    };
  } finally {
    lock.releaseLock();
  }
}

function assertEvaluationExternalSignatureWritable_(evaluationId) {
  const id = clean_(evaluationId);
  if (!id) return;
  const current = latestExternalSignatureRequest_(id);
  if (!current) return;
  expireExternalSignatureRequestIfNeeded_(current);
  const status = (latestExternalSignatureRequest_(id) || current).statut;
  if (status === 'EN_ATTENTE' || status === 'SIGNE') {
    throw new Error('EVALUATION_VERROUILLEE_SIGNATURE_AGENT');
  }
}

function attachExternalAgentSignatureToPayload_(p) {
  const evaluationId = clean_(p && p.id_evaluation);
  if (!evaluationId) return p;
  const current = latestExternalSignatureRequest_(evaluationId);
  if (!current) return p;
  expireExternalSignatureRequestIfNeeded_(current);
  const request = latestExternalSignatureRequest_(evaluationId) || current;
  if (request.statut === 'EN_ATTENTE') throw new Error('SIGNATURE_AGENT_EN_ATTENTE');
  if (request.statut !== 'SIGNE') return p;

  const ev = externalSignatureEvaluation_(evaluationId);
  assertExternalSignatureSnapshot_(request, ev);
  const connectedEvaluator = clean_(p.evaluateur);
  if (connectedEvaluator && normalize_(connectedEvaluator) !== normalize_(ev.evaluateur)) {
    throw new Error('EVALUATEUR_DIFFERENT_APRES_SIGNATURE_AGENT');
  }
  if (!request.id_fichier_signature) throw new Error('FICHIER_SIGNATURE_AGENT_MANQUANT');
  const blob = DriveApp.getFileById(request.id_fichier_signature).getBlob();
  const bytes = blob.getBytes();
  if (sha256Hex_(bytes) !== request.sha256_signature) throw new Error('EMPREINTE_SIGNATURE_AGENT_INVALIDE');

  const localSignatures = p.signatures && typeof p.signatures === 'object' ? p.signatures : {};
  p.id_agent = ev.id_agent;
  p.id_evaluation = ev.id_evaluation;
  p.grade = ev.grade;
  p.service = ev.service;
  p.date_evaluation = ev.date_evaluation;
  p.evaluateur = ev.evaluateur;
  p.lyon_le = ev.lyon_le;
  p.garder_agent = ev.garder_agent;
  p.observations_1 = ev.observations_1;
  p.observations_2 = ev.observations_2;
  p.observations_3 = ev.observations_3;
  p.observations_4 = ev.observations_4;
  p.observations_5 = ev.observations_5;
  p.observations_generales = ev.observations_generales;
  p.criteres = Object.assign({}, ev.criteres);
  p.signatures = {
    agent:'data:image/png;base64,' + Utilities.base64Encode(bytes),
    responsable:clean_(localSignatures.responsable),
    direction:clean_(localSignatures.direction)
  };
  return p;
}

function markExternalAgentSignatureFinalized_(evaluationId) {
  const id = clean_(evaluationId);
  if (!id) return;
  const current = latestExternalSignatureRequest_(id);
  if (!current || current.statut !== 'SIGNE') return;
  updateExternalSignatureRequest_(current.row_number, {statut:'FINALISE', finalise_le:new Date()});
}

function assertEvaluationReadyForExternalSignature_(ev) {
  if (!ev.grade || !ev.service || !ev.date_evaluation || !ev.evaluateur || !ev.lyon_le) {
    throw new Error('CHAMPS_EVALUATION_OBLIGATOIRES');
  }
  if (!parseIsoDate_(ev.date_evaluation) || !parseIsoDate_(ev.lyon_le)) {
    throw new Error('DATE_EVALUATION_INVALIDE');
  }
  if (!['OUI','NON'].includes(clean_(ev.garder_agent).toUpperCase())) {
    throw new Error('DECISION_GARDER_AGENT_INVALIDE');
  }
  if (!hasMeaningfulEvaluation_(ev)) throw new Error('EVALUATION_VIDE');
}

function externalSignatureEvaluation_(evaluationId) {
  const row = evaluationRows_().find(x => x.id_evaluation === evaluationId);
  if (!row) throw new Error('EVALUATION_INTROUVABLE');
  return row;
}

function publicExternalEvaluation_(ev) {
  return {
    id_evaluation:ev.id_evaluation,
    version:ev.version,
    agent:(ev.prenom + ' ' + ev.nom).trim(),
    grade:ev.grade,
    service:ev.service,
    date_evaluation:ev.date_evaluation,
    evaluateur:ev.evaluateur,
    criteres:ev.criteres,
    observations_1:ev.observations_1,
    observations_2:ev.observations_2,
    observations_3:ev.observations_3,
    observations_4:ev.observations_4,
    observations_5:ev.observations_5,
    observations_generales:ev.observations_generales,
    garder_agent:ev.garder_agent,
    lyon_le:ev.lyon_le
  };
}

function evaluationSnapshotHash_(ev) {
  const snapshot = {
    id_evaluation:ev.id_evaluation,
    version:Number(ev.version || 0),
    id_agent:ev.id_agent,
    nom:ev.nom,
    prenom:ev.prenom,
    matricule:ev.matricule,
    grade:ev.grade,
    service:ev.service,
    date_evaluation:ev.date_evaluation,
    evaluateur:ev.evaluateur,
    criteres:EVAL_CRITERIA.map(label => [label, clean_(ev.criteres && ev.criteres[label])]),
    observations:[ev.observations_1,ev.observations_2,ev.observations_3,ev.observations_4,ev.observations_5,ev.observations_generales],
    garder_agent:ev.garder_agent,
    lyon_le:ev.lyon_le
  };
  return externalSignatureHashText_(JSON.stringify(snapshot));
}

function assertExternalSignatureSnapshot_(request, ev) {
  if (evaluationSnapshotHash_(ev) !== request.empreinte_contenu) {
    throw new Error('CONTENU_EVALUATION_MODIFIE_APRES_ENVOI');
  }
}

function externalSignatureSheet_() {
  const ss = SpreadsheetApp.openById(EVAL_CONFIG.SHEET_ID);
  let sh = ss.getSheetByName(EXTERNAL_SIGNATURE_CONFIG.SHEET_NAME);
  if (!sh) sh = ss.insertSheet(EXTERNAL_SIGNATURE_CONFIG.SHEET_NAME);
  const current = sh.getLastColumn() ? sh.getRange(1,1,1,Math.max(sh.getLastColumn(), EXTERNAL_SIGNATURE_HEADERS.length)).getDisplayValues()[0] : [];
  EXTERNAL_SIGNATURE_HEADERS.forEach((header, index) => {
    if (clean_(current[index]) !== header) sh.getRange(1,index+1).setValue(header);
  });
  sh.setFrozenRows(1);
  return sh;
}

function externalSignatureRows_() {
  const sh = externalSignatureSheet_();
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2,1,sh.getLastRow()-1,EXTERNAL_SIGNATURE_HEADERS.length).getValues()
    .map((r,i) => ({
      row_number:i+2,
      id_demande:clean_(r[0]),
      id_evaluation:clean_(r[1]),
      id_agent:clean_(r[2]),
      token_hash:clean_(r[3]),
      statut:clean_(r[4]),
      empreinte_contenu:clean_(r[5]),
      cree_le:r[6],
      expire_le:r[7],
      signe_le:r[8],
      id_fichier_signature:clean_(r[9]),
      sha256_signature:clean_(r[10]),
      demandeur:clean_(r[11]),
      annule_le:r[12],
      finalise_le:r[13]
    }))
    .filter(x => x.id_demande && x.id_evaluation);
}

function latestExternalSignatureRequest_(evaluationId) {
  const rows = externalSignatureRows_().filter(x => x.id_evaluation === evaluationId);
  return rows.length ? rows[rows.length - 1] : null;
}

function requireExternalSignatureByToken_(rawToken, allowSigned) {
  const token = clean_(rawToken);
  if (!/^[A-Za-z0-9_-]{40,120}$/.test(token)) throw new Error('LIEN_SIGNATURE_INVALIDE');
  const hash = externalSignatureHashText_(token);
  const request = externalSignatureRows_().find(x => x.token_hash === hash);
  if (!request) throw new Error('LIEN_SIGNATURE_INVALIDE');
  expireExternalSignatureRequestIfNeeded_(request);
  const refreshed = externalSignatureRows_().find(x => x.id_demande === request.id_demande) || request;
  if (refreshed.statut === 'SIGNE' && allowSigned) return refreshed;
  if (refreshed.statut !== 'EN_ATTENTE' && refreshed.statut !== 'SIGNE') throw new Error('LIEN_SIGNATURE_INVALIDE');
  return refreshed;
}

function expireExternalSignatureRequestIfNeeded_(request) {
  if (!request || request.statut !== 'EN_ATTENTE') return;
  const expires = request.expire_le instanceof Date ? request.expire_le : new Date(request.expire_le);
  if (!expires || isNaN(expires.getTime()) || expires.getTime() >= Date.now()) return;
  updateExternalSignatureRequest_(request.row_number, {statut:'EXPIRE'});
}

function updateExternalSignatureRequest_(row, changes) {
  const sh = externalSignatureSheet_();
  const map = {
    statut:5,
    signe_le:9,
    id_fichier_signature:10,
    sha256_signature:11,
    annule_le:13,
    finalise_le:14
  };
  Object.keys(changes || {}).forEach(key => {
    const col = map[key];
    if (col) sh.getRange(row,col).setValue(changes[key]);
  });
}

function publicExternalSignatureStatus_(request) {
  return {
    id_demande:request.id_demande,
    id_evaluation:request.id_evaluation,
    statut:request.statut,
    cree_le:formatDateTimeForClient_(request.cree_le),
    expire_le:formatDateTimeForClient_(request.expire_le),
    signe_le:formatDateTimeForClient_(request.signe_le),
    demandeur:request.demandeur
  };
}

function createExternalSignatureToken_() {
  return [Utilities.getUuid(),Utilities.getUuid(),Utilities.getUuid()]
    .map(value => value.replace(/-/g,''))
    .join('');
}

function externalSignatureHashText_(text) {
  return Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(text || ''),
    Utilities.Charset.UTF_8
  ).map(b => ('0' + ((b < 0 ? b + 256 : b).toString(16))).slice(-2)).join('');
}

function normalizeExternalSignaturePng_(value) {
  const signature = clean_(value);
  if (!signature) return '';
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signature)) throw new Error('SIGNATURE_INVALIDE');
  if (signature.length > 350000) throw new Error('SIGNATURE_TROP_VOLUMINEUSE');
  return signature;
}

function externalSignatureFolder_() {
  const parent = DriveApp.getFolderById(EVAL_CONFIG.DEST_FOLDER_ID);
  const folders = parent.getFoldersByName(EXTERNAL_SIGNATURE_CONFIG.SIGNATURE_FOLDER_NAME);
  return folders.hasNext() ? folders.next() : parent.createFolder(EXTERNAL_SIGNATURE_CONFIG.SIGNATURE_FOLDER_NAME);
}

function saveExternalSignatureFile_(requestId, dataUrl) {
  const bytes = Utilities.base64Decode(dataUrl.split(',')[1]);
  const blob = Utilities.newBlob(bytes, 'image/png', requestId + '.png');
  const file = externalSignatureFolder_().createFile(blob);
  return {file, sha256:sha256Hex_(bytes)};
}

function trashExternalSignatureFile_(fileId) {
  const id = clean_(fileId);
  if (!id) return;
  try { DriveApp.getFileById(id).setTrashed(true); } catch (_) {}
}

function TESTER_SIGNATURES_EXTERNES() {
  const sh = externalSignatureSheet_();
  externalSignatureFolder_().getName();
  return {
    ok:true,
    sheet:sh.getName(),
    expiration_jours:EXTERNAL_SIGNATURE_CONFIG.EXPIRY_DAYS,
    url:EXTERNAL_SIGNATURE_CONFIG.PUBLIC_URL
  };
}
