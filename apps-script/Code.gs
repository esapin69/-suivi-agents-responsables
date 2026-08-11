const CONFIG = {
  SOURCE_ID: '16AawBJMEUl-9tNI6lMZqYm2E4SCWvHD5F_vIsPQSPr4',
  SOURCE_SHEET: 'Agents',
  TEMPLATE_ID: '1C6Ur7UL_4EpOvVvm9ivSPxzKcAVhxlZcDkDstmZ0_zLc',
  DEST_FOLDER_ID: '1mQ2yGV4BuBN0fcf9TGPLHPgNQodg079-',
  ACCESS_SHEET: 'Annuaire',
  PEOPLE_SHEET: 'PERSONNES',
  ADMIN_SHEET: 'ADMINISTRATION',
  SERVICES_SHEET: 'SERVICES',
  SITUATIONS_SHEET: 'Situations sécurisées'
};

const COL = {
  ID: 1, NOM: 2, PRENOM: 3, TELEPHONE: 4, MATRICULE: 5,
  DATE_ARRIVEE: 6, EXPERIENCES: 7, VERIFICATION: 8, FILE_ID: 9,
  FILE_URL: 10, CREE_LE: 11, MODIFIE_LE: 12, PREMIER_JOUR_STATUT: 13,
  PREMIER_JOUR_DATE: 14, PREMIER_JOUR_MODIFIE_LE: 15
};

function doGet(e) {
  try {
    checkKey_(e.parameter.key);
    const action = String(e.parameter.action || 'health');
    let result;

    if (action === 'health') {
      result = {
        ok: true,
        service: 'suivi-agents',
        source: CONFIG.SOURCE_SHEET,
        bridge: 'ok',
        time: new Date().toISOString()
      };
    } else {
      const principal = requireAuthorizedPrincipal_(
        String(e.parameter.auth_user_id || ''),
        String(e.parameter.auth_session_version || '')
      );

      if (action === 'authorizeAccess') {
        result = {ok:true, user:publicAccessUser_(principal)};
      } else if (action === 'listDirectory') {
        requireAnyAccess_(principal, ['suivi_des_agents', 'contacts']);
        result = {ok:true, agents:listDirectory_()};
      } else {
        requireAccess_(principal, accessForAction_(action));
        if (action === 'listAgents') {
          result = {ok:true, agents:listAgents_()};
        } else if (action === 'getAgent') {
          result = {ok:true, agent:getAgent_(String(e.parameter.id || ''))};
        } else if (action === 'getFirstDay') {
          result = {ok:true, first_day:getFirstDay_(String(e.parameter.id || ''))};
        } else if (action === 'listEvaluations') {
          result = {ok:true, evaluations:listEvaluations_(String(e.parameter.id || ''))};
        } else if (action === 'getEvaluation') {
          result = {ok:true, evaluation:getEvaluationById_(String(e.parameter.id || ''))};
        } else {
          throw new Error('ACTION_INCONNUE');
        }
      }
    }
    return json_(result);
  } catch (err) {
    return json_(errorPayload_(err));
  }
}

function doPost(e) {
  try {
    const payload = parsePayload_(e);
    checkKey_(payload.key);
    const action = String(payload.action || '');
    let result;

    if (action === 'authenticateAccess') {
      result = authenticateAccess_(payload.code);
    } else {
      const principal = requireAuthorizedPrincipal_(
        payload.auth_user_id,
        payload.auth_session_version
      );
      requireAccess_(principal, accessForAction_(action));
      const responsibleName = principal.prenom + ' ' + principal.nom;

      if (action === 'createAgent') result = createAgent_(payload);
      else if (action === 'updateAgent') result = updateAgent_(payload);
      else if (action === 'saveFirstDay') {
        payload.chef_nom = responsibleName;
        result = saveFirstDay_(payload);
      }
      else if (action === 'saveEvaluationDraft') {
        payload.evaluateur = responsibleName;
        result = saveEvaluationDraft_(payload);
      }
      else if (action === 'finalizeEvaluation') {
        payload.evaluateur = responsibleName;
        result = finalizeEvaluation_(payload);
      }
      else if (action === 'submitSituation') {
        result = submitSituation_(payload, principal);
      }
      else throw new Error('ACTION_INCONNUE');
    }

    return json_(result);
  } catch (err) {
    return json_(errorPayload_(err));
  }
}

/* ========================= AUTH / DROITS ========================= */

function authenticateAccess_(inputCode) {
  const code = clean_(inputCode);
  if (!/^\d{6}$/.test(code)) throw new Error('AUTH_INVALIDE');

  const rows = accessRows_();
  let matched = null;
  let matches = 0;
  rows.forEach(row => {
    if (safeSecretEquals_(row.code, code)) {
      matched = row;
      matches++;
    }
  });

  if (matches !== 1 || !matched || !isAuthorizedAccessRow_(matched)) {
    throw new Error('AUTH_INVALIDE');
  }

  return {
    ok: true,
    user: publicAccessUser_(matched),
    session_version: accessSessionVersion_(matched)
  };
}

function requireAuthorizedPrincipal_(principalId, sessionVersion) {
  const id = clean_(principalId);
  const version = clean_(sessionVersion);
  if (!id || !version) throw new Error('AUTH_REQUISE');

  const matches = accessRows_().filter(
    row => row.id === id && isAuthorizedAccessRow_(row)
  );
  if (matches.length !== 1) throw new Error('AUTH_REQUISE');
  if (!safeSecretEquals_(accessSessionVersion_(matches[0]), version)) {
    throw new Error('AUTH_REQUISE');
  }
  return matches[0];
}

function getApiKey_() {
  const key = String(
    PropertiesService.getScriptProperties().getProperty('API_KEY') || ''
  ).trim();
  if (!key) throw new Error('CONFIG_API_KEY_MANQUANTE');
  return key;
}

function accessSessionVersion_(row) {
  const signature = Utilities.computeHmacSha256Signature(
    row.id + '|' + row.code,
    getApiKey_(),
    Utilities.Charset.UTF_8
  );
  return Utilities.base64EncodeWebSafe(signature).replace(/=+$/, '');
}

function accessRows_() {
  const sh = SpreadsheetApp.openById(CONFIG.SOURCE_ID).getSheetByName(CONFIG.ACCESS_SHEET);
  if (!sh) throw new Error('ONGLET_ANNUAIRE_MANQUANT');
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];

  const lastCol = sh.getLastColumn();
  const headers = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
  return sh.getRange(2, 1, lastRow - 1, lastCol).getDisplayValues()
    .filter(row => clean_(row[0]) && clean_(row[1]))
    .map(row => {
      const nom = clean_(row[0]).toUpperCase();
      const prenom = clean_(row[1]);
      const poste = clean_(row[2]);
      const code = clean_(row[3]);
      const access = {};
      for (let i = 4; i < headers.length; i++) {
        const key = accessKey_(headers[i]);
        if (key) access[key] = normalize_(row[i]) === 'OK';
      }
      return {
        id: normalize_(nom) + '|' + normalize_(prenom),
        nom, prenom, poste, code, access
      };
    });
}

function accessKey_(header) {
  return clean_(header)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function requireAccess_(principal, key) {
  if (!key) return;
  if (!principal || !principal.access || principal.access[key] !== true) {
    throw new Error('ACCES_REFUSE');
  }
}

function requireAnyAccess_(principal, keys) {
  const access = principal && principal.access ? principal.access : {};
  if (!keys.some(key => access[key] === true)) throw new Error('ACCES_REFUSE');
}

function accessForAction_(action) {
  const map = {
    listAgents: 'suivi_des_agents',
    getAgent: 'suivi_des_agents',
    getFirstDay: 'suivi_des_agents',
    listEvaluations: 'suivi_des_agents',
    getEvaluation: 'suivi_des_agents',
    createAgent: 'suivi_des_agents',
    updateAgent: 'suivi_des_agents',
    saveFirstDay: 'suivi_des_agents',
    saveEvaluationDraft: 'suivi_des_agents',
    finalizeEvaluation: 'suivi_des_agents',
    submitSituation: 'suivi_des_agents'
  };
  return map[action] || '';
}

function isAuthorizedAccessRow_(row) {
  return /^\d{6}$/.test(row.code);
}

function publicAccessUser_(row) {
  const isAdmin = normalize_(row.nom) === 'SAPIN' && normalize_(row.prenom) === 'EDDY';
  return {
    id: row.id,
    nom: row.nom,
    prenom: row.prenom,
    poste: row.poste,
    display_name: row.prenom + ' ' + row.nom,
    is_admin: isAdmin,
    access: row.access || {}
  };
}

function safeSecretEquals_(left, right) {
  const a = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(left || ''),
    Utilities.Charset.UTF_8
  );
  const b = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(right || ''),
    Utilities.Charset.UTF_8
  );
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    difference |= (a[i % a.length] ^ b[i % b.length]);
  }
  return difference === 0;
}

/* ========================= SITUATIONS ========================= */

function submitSituation_(p, principal) {
  const id = clean_(p.id_agent);
  if (!id) throw new Error('ID_AGENT_MANQUANT');
  const agent = getAgent_(id);
  if (!agent) throw new Error('AGENT_INTROUVABLE');

  const impact = clean_(p.impact);
  const allowed = ['🟢 Bénéfique', '⚪ Neutre', '🔴 Problématique'];
  if (allowed.indexOf(impact) < 0) throw new Error('IMPACT_INVALIDE');

  const contexte = boundedText_(p.contexte, 2000, 'CONTEXTE_TROP_LONG');
  const consequence = boundedText_(p.consequence, 2000, 'CONSEQUENCE_TROP_LONGUE');
  const fait = boundedText_(p.fait, 4000, 'FAIT_TROP_LONG');
  if (!fait) throw new Error('FAIT_REQUIS');

  const responsable = principal.prenom + ' ' + principal.nom;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = situationsSheet_();
    const situationId = 'SIT-' + Utilities.getUuid().replace(/-/g, '').slice(0, 12).toUpperCase();
    const now = new Date();
    sheet.appendRow([
      situationId, agent.id_agent, agent.nom, agent.prenom,
      impact, contexte, consequence, fait, responsable, principal.id
    ].map(safeSheetText_).concat([now]));
    SpreadsheetApp.flush();
    const row = sheet.getLastRow();
    const verified = sheet.getRange(row, 1, 1, 11).getValues()[0];
    if (clean_(verified[0]) !== situationId || clean_(verified[1]) !== agent.id_agent) {
      throw new Error('VERIFICATION_SITUATION_ECHOUEE');
    }
    return {
      ok:true, verified:true, id_situation:situationId,
      agent:{id_agent:agent.id_agent, nom:agent.nom, prenom:agent.prenom},
      responsable, cree_le:formatDateTimeForClient_(now)
    };
  } finally {
    lock.releaseLock();
  }
}

function situationsSheet_() {
  const ss = SpreadsheetApp.openById(CONFIG.SOURCE_ID);
  let sh = ss.getSheetByName(CONFIG.SITUATIONS_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.SITUATIONS_SHEET);
    const headers = [
      'ID situation','ID agent','Nom','Prénom','Impact','Contexte','Conséquence',
      'Fait','Responsable','Identifiant responsable','Créé le'
    ];
    sh.getRange(1,1,1,headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#15a9d4')
      .setFontColor('#ffffff').setHorizontalAlignment('center');
    sh.setFrozenRows(1);
    sh.autoResizeColumns(1, headers.length);
  }
  return sh;
}

/* ========================= AGENTS ========================= */

function createAgent_(p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const nom = boundedText_(p.nom,120,'NOM_TROP_LONG').toUpperCase();
    const prenom = boundedText_(p.prenom,120,'PRENOM_TROP_LONG');
    const telephone = boundedText_(p.telephone,50,'TELEPHONE_TROP_LONG');
    const matricule = boundedText_(p.matricule,100,'MATRICULE_TROP_LONG');
    const dateArrivee = clean_(p.date_arrivee);
    const experiences = boundedText_(p.experiences,10000,'EXPERIENCES_TROP_LONGUES');
    const force = String(p.force || '') === '1' || p.force === true;
    const id = clean_(p.id_agent) || createId_();

    if (!nom || !prenom || !dateArrivee) throw new Error('CHAMPS_OBLIGATOIRES');
    if (!parseIsoDate_(dateArrivee)) throw new Error('DATE_ARRIVEE_INVALIDE');
    if (!findDirectoryAgent_(nom, prenom)) throw new Error('AGENT_ABSENT_ANNUAIRE');

    const sheet = sourceSheet_();
    const rows = readRows_(sheet);
    if (rows.some(r => clean_(r[COL.ID-1]) === id)) {
      return {ok:true, alreadyExists:true, agent:getAgent_(id)};
    }

    if (matricule) {
      const same = rows.find(r => normalize_(r[COL.MATRICULE-1]) === normalize_(matricule));
      if (same) return {
        ok:false, code:'MATRICULE_EXISTANT', message:'Ce matricule est déjà utilisé.',
        existing:minimalAgentFromRow_(same)
      };
    }

    const matches = rows.filter(r =>
      normalize_(r[COL.NOM-1]) === normalize_(nom) &&
      normalize_(r[COL.PRENOM-1]) === normalize_(prenom)
    );
    if (matches.length && !force) return {
      ok:false, code:'NOM_DEJA_PRESENT',
      message:'Un agent portant ce nom et ce prénom existe déjà.',
      candidates:matches.map(minimalAgentFromRow_)
    };

    const verification = matricule ? 'VERIFIE' : 'PROVISOIRE';
    const now = new Date();
    const copy = DriveApp.getFileById(CONFIG.TEMPLATE_ID).makeCopy(
      `${nom} ${prenom} - BROUILLON`, DriveApp.getFolderById(CONFIG.DEST_FOLDER_ID)
    );

    try {
      fillIdentitySheet_(copy.getId(), {nom,prenom,telephone,matricule,dateArrivee,experiences});
      sheet.appendRow([
        id,nom,prenom,telephone,matricule,dateArrivee,experiences,verification,
        copy.getId(),copy.getUrl()
      ].map(safeSheetText_).concat([now,now]));
      SpreadsheetApp.flush();
      const verified = getAgent_(id);
      if (!verified || verified.id_agent !== id || verified.fichier_brouillon_id !== copy.getId()) {
        throw new Error('VERIFICATION_APRES_ECRITURE_ECHOUEE');
      }
      return {ok:true, verified:true, message:'Agent créé et vérifié.', agent:verified};
    } catch (err) {
      try { copy.setTrashed(true); } catch (_) {}
      throw err;
    }
  } finally {
    lock.releaseLock();
  }
}

function updateAgent_(p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const id = clean_(p.id_agent);
    if (!id) throw new Error('ID_AGENT_MANQUANT');
    const sheet = sourceSheet_();
    const values = sheet.getDataRange().getValues();
    const rowIndex = values.findIndex((r,i) => i > 0 && clean_(r[COL.ID-1]) === id);
    if (rowIndex < 1) throw new Error('AGENT_INTROUVABLE');

    const current = values[rowIndex];
    const nom = boundedText_(p.nom || current[COL.NOM-1],120,'NOM_TROP_LONG').toUpperCase();
    const prenom = boundedText_(p.prenom || current[COL.PRENOM-1],120,'PRENOM_TROP_LONG');
    const telephone = boundedText_(p.telephone !== undefined ? p.telephone : current[COL.TELEPHONE-1],50,'TELEPHONE_TROP_LONG');
    const matricule = boundedText_(p.matricule !== undefined ? p.matricule : current[COL.MATRICULE-1],100,'MATRICULE_TROP_LONG');
    const dateArrivee = p.date_arrivee !== undefined ? clean_(p.date_arrivee) : clean_(current[COL.DATE_ARRIVEE-1]);
    const experiences = boundedText_(p.experiences !== undefined ? p.experiences : current[COL.EXPERIENCES-1],10000,'EXPERIENCES_TROP_LONGUES');

    if (!nom || !prenom || !dateArrivee) throw new Error('CHAMPS_OBLIGATOIRES');
    if (!parseIsoDate_(dateArrivee)) throw new Error('DATE_ARRIVEE_INVALIDE');
    if (!findDirectoryAgent_(nom, prenom)) throw new Error('AGENT_ABSENT_ANNUAIRE');

    if (matricule) {
      const duplicate = values.find((r,i) =>
        i > 0 && i !== rowIndex && normalize_(r[COL.MATRICULE-1]) === normalize_(matricule)
      );
      if (duplicate) return {
        ok:false, code:'MATRICULE_EXISTANT', message:'Ce matricule est déjà utilisé.',
        existing:minimalAgentFromRow_(duplicate)
      };
    }

    const fileId = clean_(current[COL.FILE_ID-1]);
    if (!fileId) throw new Error('FICHIER_BROUILLON_MANQUANT');
    fillIdentitySheet_(fileId, {nom,prenom,telephone,matricule,dateArrivee,experiences});
    DriveApp.getFileById(fileId).setName(`${nom} ${prenom} - BROUILLON`);
    sheet.getRange(rowIndex+1,COL.NOM,1,7).setValues([[
      nom,prenom,telephone,matricule,dateArrivee,experiences,
      matricule ? 'VERIFIE' : 'PROVISOIRE'
    ].map(safeSheetText_)]);
    sheet.getRange(rowIndex+1,COL.MODIFIE_LE).setValue(new Date());
    SpreadsheetApp.flush();
    return {ok:true, verified:true, message:'Modifications enregistrées et vérifiées.', agent:getAgent_(id)};
  } finally {
    lock.releaseLock();
  }
}

function fillIdentitySheet_(spreadsheetId, a) {
  const sh = SpreadsheetApp.openById(spreadsheetId).getSheetByName('fiche brancardier');
  if (!sh) throw new Error('ONGLET_FICHE_BRANCARDIER_MANQUANT');
  sh.getRange('C5').setValue(safeSheetText_(a.nom));
  sh.getRange('C6').setValue(safeSheetText_(a.prenom));
  sh.getRange('C7').setValue(safeSheetText_(a.telephone));
  sh.getRange('C8').setValue(safeSheetText_(a.matricule));
  if (a.dateArrivee) {
    const parts = String(a.dateArrivee).split('-');
    if (parts.length === 3) {
      sh.getRange('C9').setValue(new Date(Number(parts[0]),Number(parts[1])-1,Number(parts[2])));
      sh.getRange('C9').setNumberFormat('dd/MM/yyyy');
    } else sh.getRange('C9').setValue(a.dateArrivee);
  } else sh.getRange('C9').clearContent();
  sh.getRange('A12').setValue(safeSheetText_(a.experiences));
  SpreadsheetApp.flush();
}

/* ========================= PREMIER JOUR ========================= */

function getFirstDay_(id) {
  if (!id) throw new Error('ID_AGENT_MANQUANT');
  const agent = getAgent_(id);
  if (!agent) throw new Error('AGENT_INTROUVABLE');
  if (!agent.fichier_brouillon_id) throw new Error('FICHIER_BROUILLON_MANQUANT');
  const sh = SpreadsheetApp.openById(agent.fichier_brouillon_id).getSheetByName('1er jour');
  if (!sh) throw new Error('ONGLET_PREMIER_JOUR_MANQUANT');

  const roles = sh.getRange('B5:D28').getDisplayValues();
  const observations = sh.getRange('E5:E28').getDisplayValues();
  const items = roles.map((r,i) => ({
    row:i+5, cadre:isChecked_(r[0]), chef:isChecked_(r[1]), tuteur:isChecked_(r[2]),
    observation:clean_(observations[i][0])
  }));
  const completed = items.filter(x => x.cadre || x.chef || x.tuteur).length;
  return {
    id_agent:id,
    statut:agent.premier_jour_statut || 'A_FAIRE',
    date_validation:agent.premier_jour_date || extractDateFromValidation_(clean_(sh.getRange('C30').getDisplayValue())),
    chef_nom:extractChefName_(clean_(sh.getRange('A30').getDisplayValue())),
    completed, total:24, items,
    modified_at:agent.premier_jour_modifie_le || ''
  };
}

function saveFirstDay_(p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const id = clean_(p.id_agent);
    if (!id) throw new Error('ID_AGENT_MANQUANT');
    const sheet = sourceSheet_();
    const values = sheet.getDataRange().getValues();
    const rowIndex = values.findIndex((r,i) => i > 0 && clean_(r[COL.ID-1]) === id);
    if (rowIndex < 1) throw new Error('AGENT_INTROUVABLE');
    const agentRow = values[rowIndex];
    const fileId = clean_(agentRow[COL.FILE_ID-1]);
    if (!fileId) throw new Error('FICHIER_BROUILLON_MANQUANT');

    const ss = SpreadsheetApp.openById(fileId);
    const sh = ss.getSheetByName('1er jour');
    if (!sh) throw new Error('ONGLET_PREMIER_JOUR_MANQUANT');
    const incoming = Array.isArray(p.items) ? p.items : [];
    if (incoming.length !== 24) throw new Error('PREMIER_JOUR_24_ETAPES_REQUISES');

    const normalized = incoming.map((x,i) => ({
      row:i+5, cadre:Boolean(x.cadre), chef:Boolean(x.chef), tuteur:Boolean(x.tuteur),
      observation:boundedText_(x.observation,4000,'OBSERVATION_TROP_LONGUE')
    }));
    const completed = normalized.filter(x => x.cadre || x.chef || x.tuteur).length;
    const wantsFinalize = p.finalize === true || String(p.finalize || '') === '1';
    const currentStatus = clean_(agentRow[COL.PREMIER_JOUR_STATUT-1]) || 'A_FAIRE';
    const chefNom = clean_(p.chef_nom);
    const dateValidation = clean_(p.date_validation);

    if (wantsFinalize) {
      if (completed !== 24) throw new Error('PREMIER_JOUR_INCOMPLET');
      if (!chefNom) throw new Error('CHEF_EQUIPE_REQUIS');
      if (!dateValidation) throw new Error('DATE_VALIDATION_REQUISE');
    }

    sh.getRange('B5:D28').setValues(normalized.map(x => [
      x.cadre ? '☒' : '☐', x.chef ? '☒' : '☐', x.tuteur ? '☒' : '☐'
    ]));
    sh.getRange('E5:E28').setValues(normalized.map(x => [safeSheetText_(x.observation)]));

    let newStatus = currentStatus;
    if (wantsFinalize) {
      newStatus = 'TERMINE';
      sh.getRange('A30').setValue('CHEF D’ÉQUIPE – NOM ET PRÉNOM : ' + chefNom);
      sh.getRange('C30').setValue('DATE : ' + displayDateFr_(dateValidation));
      const fiche = ss.getSheetByName('fiche brancardier');
      if (fiche) {
        const d = parseIsoDate_(dateValidation);
        fiche.getRange('D17').setValue(d || dateValidation);
        if (d) fiche.getRange('D17').setNumberFormat('dd/MM/yyyy');
      }
    } else if (currentStatus !== 'TERMINE') {
      newStatus = completed > 0 || normalized.some(x => x.observation) ? 'BROUILLON' : 'A_FAIRE';
    }

    const rowNumber = rowIndex + 1;
    sheet.getRange(rowNumber,COL.PREMIER_JOUR_STATUT).setValue(newStatus);
    if (newStatus === 'TERMINE' && dateValidation) {
      const d = parseIsoDate_(dateValidation);
      sheet.getRange(rowNumber,COL.PREMIER_JOUR_DATE).setValue(d || dateValidation);
      if (d) sheet.getRange(rowNumber,COL.PREMIER_JOUR_DATE).setNumberFormat('dd/MM/yyyy');
    }
    sheet.getRange(rowNumber,COL.PREMIER_JOUR_MODIFIE_LE).setValue(new Date());
    SpreadsheetApp.flush();
    const verified = getFirstDay_(id);
    if (!verified || verified.completed !== completed) throw new Error('VERIFICATION_PREMIER_JOUR_ECHOUEE');
    return {
      ok:true, verified:true,
      message:newStatus === 'TERMINE' ? '1er jour terminé, enregistré et vérifié.' : 'Brouillon enregistré et vérifié.',
      first_day:verified, agent:getAgent_(id)
    };
  } finally {
    lock.releaseLock();
  }
}

function isChecked_(value) {
  const s = clean_(value).toUpperCase();
  return s === '☒' || s === 'TRUE' || s === 'X' || s === 'OUI' || s === '1';
}
function extractChefName_(value) {
  const s = clean_(value), i = s.indexOf(':');
  return i >= 0 ? s.slice(i+1).trim() : '';
}
function extractDateFromValidation_(value) {
  const m = clean_(value).match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

/* ========================= ANNUAIRE / CONTACTS ========================= */

function listAgents_() {
  return readRows_(sourceSheet_())
    .filter(r => clean_(r[COL.ID-1]))
    .map(minimalAgentFromRow_)
    .sort((a,b) => (a.nom+' '+a.prenom).localeCompare(b.nom+' '+b.prenom,'fr'));
}

function listDirectory_() {
  const ss = SpreadsheetApp.openById(CONFIG.SOURCE_ID);
  const accessSheet = ss.getSheetByName(CONFIG.ACCESS_SHEET);
  if (!accessSheet) throw new Error('ONGLET_ANNUAIRE_MANQUANT');

  const tracked = listAgents_();
  const trackedByName = {};
  tracked.forEach(a => trackedByName[personKey_(a.nom,a.prenom)] = a);

  const accessByName = {};
  const accessLastRow = accessSheet.getLastRow();
  if (accessLastRow >= 2) {
    accessSheet.getRange(2,1,accessLastRow-1,3).getDisplayValues()
      .filter(r => clean_(r[0]) && clean_(r[1]))
      .forEach(r => {
        accessByName[personKey_(r[0],r[1])] = {
          nom:clean_(r[0]).toUpperCase(),
          prenom:clean_(r[1]),
          poste:clean_(r[2])
        };
      });
  }

  const people = [];
  const used = {};
  const peopleSheet = ss.getSheetByName(CONFIG.PEOPLE_SHEET);
  if (peopleSheet && peopleSheet.getLastRow() >= 2) {
    peopleSheet.getRange(2,1,peopleSheet.getLastRow()-1,8).getDisplayValues()
      .filter(r => clean_(r[2]) && clean_(r[3]))
      .forEach(r => {
        const key = personKey_(r[2],r[3]);
        const access = accessByName[key] || null;
        const existing = trackedByName[key] || null;
        used[key] = true;
        people.push({
          type:'personne',
          categorie:'personnes',
          ghe:clean_(r[0]),
          icone:clean_(r[1]) || '👤',
          nom:clean_(r[2]).toUpperCase(),
          prenom:clean_(r[3]),
          alias:clean_(r[4]),
          telephone:clean_(r[5]),
          email_pro:clean_(r[6]),
          email_perso:clean_(r[7]),
          poste:access ? access.poste : '',
          role:access ? access.poste : '',
          eligible_agent:Boolean(access),
          suivi_existant:Boolean(existing),
          id_agent:existing ? existing.id_agent : ''
        });
      });
  }

  Object.keys(accessByName).forEach(key => {
    if (used[key]) return;
    const a = accessByName[key];
    const existing = trackedByName[key] || null;
    people.push({
      type:'personne', categorie:'personnes', ghe:'', icone:'👤',
      nom:a.nom, prenom:a.prenom, alias:'', telephone:'', email_pro:'', email_perso:'',
      poste:a.poste, role:a.poste, eligible_agent:true,
      suivi_existant:Boolean(existing), id_agent:existing ? existing.id_agent : ''
    });
  });

  const admins = readPeopleLikeSheet_(ss.getSheetByName(CONFIG.ADMIN_SHEET), 'administration');
  const services = readServicesSheet_(ss.getSheetByName(CONFIG.SERVICES_SHEET));

  return people.concat(admins,services).sort((a,b) =>
    directorySortName_(a).localeCompare(directorySortName_(b),'fr')
  );
}

function readPeopleLikeSheet_(sh, categorie) {
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2,1,sh.getLastRow()-1,8).getDisplayValues()
    .filter(r => clean_(r[2]) && clean_(r[3]))
    .map(r => ({
      type:'personne', categorie,
      ghe:clean_(r[0]), icone:clean_(r[1]) || '👤',
      nom:clean_(r[2]).toUpperCase(), prenom:clean_(r[3]), alias:clean_(r[4]),
      telephone:clean_(r[5]), email_pro:clean_(r[6]), email_perso:clean_(r[7]),
      poste:categorie === 'administration' ? 'Administration' : '',
      role:categorie === 'administration' ? 'Administration' : '',
      eligible_agent:false, suivi_existant:false, id_agent:''
    }));
}

function readServicesSheet_(sh) {
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2,1,sh.getLastRow()-1,4).getDisplayValues()
    .filter(r => clean_(r[0]))
    .map(r => ({
      type:'service', categorie:'services', nom:clean_(r[0]), prenom:'',
      ghe:clean_(r[1]), icone:'☎', telephone:clean_(r[2]), dect:clean_(r[3]),
      email_pro:'', email_perso:'', alias:'', poste:'Service', role:'Service',
      eligible_agent:false, suivi_existant:false, id_agent:''
    }));
}

function directorySortName_(a) {
  return a.type === 'service' ? clean_(a.nom) : clean_(a.nom) + ' ' + clean_(a.prenom);
}
function personKey_(nom,prenom) {
  return normalize_(nom) + '|' + normalize_(prenom);
}

function findDirectoryAgent_(nom, prenom) {
  const sh = SpreadsheetApp.openById(CONFIG.SOURCE_ID).getSheetByName(CONFIG.ACCESS_SHEET);
  if (!sh) throw new Error('ONGLET_ANNUAIRE_MANQUANT');
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return null;
  const target = personKey_(nom,prenom);
  const row = sh.getRange(2,1,lastRow-1,3).getDisplayValues()
    .find(r => personKey_(r[0],r[1]) === target);
  return row ? {nom:clean_(row[0]), prenom:clean_(row[1]), poste:clean_(row[2])} : null;
}

/* ========================= LECTURE AGENT / UTILITAIRES ========================= */

function getAgent_(id) {
  if (!id) throw new Error('ID_AGENT_MANQUANT');
  const sheet = sourceSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const r = sheet.getRange(2,1,lastRow-1,15).getValues()
    .find(row => clean_(row[COL.ID-1]) === id);
  if (!r) return null;
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

function minimalAgentFromRow_(r) {
  return {
    id_agent:clean_(r[COL.ID-1]), nom:clean_(r[COL.NOM-1]), prenom:clean_(r[COL.PRENOM-1]),
    matricule:clean_(r[COL.MATRICULE-1]), verification:clean_(r[COL.VERIFICATION-1])
  };
}

function sourceSheet_() {
  const sh = SpreadsheetApp.openById(CONFIG.SOURCE_ID).getSheetByName(CONFIG.SOURCE_SHEET);
  if (!sh) throw new Error('ONGLET_AGENTS_MANQUANT');
  return sh;
}
function readRows_(sheet) {
  const lastRow = sheet.getLastRow();
  return lastRow < 2 ? [] : sheet.getRange(2,1,lastRow-1,12).getValues();
}
function boundedText_(value,maxLength,errorCode) {
  const text = clean_(value);
  if (text.length > maxLength) throw new Error(errorCode);
  return text;
}
function parseIsoDate_(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y=Number(m[1]), mo=Number(m[2]), d=Number(m[3]);
  const date = new Date(y,mo-1,d);
  return date.getFullYear()===y && date.getMonth()===mo-1 && date.getDate()===d ? date : null;
}
function displayDateFr_(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : clean_(value);
}
function formatDateTimeForClient_(value) {
  if (!value) return '';
  return value instanceof Date
    ? Utilities.formatDate(value,'Europe/Paris',"yyyy-MM-dd'T'HH:mm:ss")
    : clean_(value);
}
function parsePayload_(e) {
  if (e && e.parameter && e.parameter.payload) return JSON.parse(e.parameter.payload);
  if (e && e.postData && e.postData.contents) {
    try { return JSON.parse(e.postData.contents); } catch (_) {}
  }
  return e && e.parameter ? e.parameter : {};
}
function checkKey_(key) {
  const received = String(key || '').trim();
  if (!received || !safeSecretEquals_(received,getApiKey_())) throw new Error('ACCES_REFUSE');
}
function createId_() {
  return 'AG-' + Utilities.getUuid().replace(/-/g,'').slice(0,12).toUpperCase();
}
function normalize_(value) {
  return clean_(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-zA-Z0-9]/g,'').toUpperCase();
}
function clean_(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return Utilities.formatDate(value,'Europe/Paris','yyyy-MM-dd');
  return String(value).trim();
}
function safeSheetText_(value) {
  const text = clean_(value);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}
function formatDateForClient_(value) {
  if (!value) return '';
  return value instanceof Date ? Utilities.formatDate(value,'Europe/Paris','yyyy-MM-dd') : clean_(value);
}
function errorPayload_(err) {
  return {ok:false, code:String(err && err.message ? err.message : err), message:String(err && err.message ? err.message : err)};
}
function json_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function testSecurityConfiguration() {
  const authorized = accessRows_().filter(isAuthorizedAccessRow_).map(row => ({
    nom:row.nom, prenom:row.prenom, poste:row.poste,
    is_admin:publicAccessUser_(row).is_admin, access:row.access
  }));
  return {ok:true, authorized_count:authorized.length, authorized};
}
