/**
 * SUIVI_COMPLET.gs
 *
 * Moteur unifié du dossier individuel de suivi.
 * À utiliser dans le MÊME projet Apps Script que Code.gs et EVALUATIONS.gs.
 *
 * Principes :
 * - une seule source Agents : CONFIG.SOURCE_ID / CONFIG.SOURCE_SHEET ;
 * - un seul fichier individuel par agent : l'ID déjà stocké dans la ligne Agents ;
 * - aucune deuxième base AGENTS et aucun deuxième registre FICHIERS_AGENTS ;
 * - les étapes du parcours écrivent dans les onglets de la maquette ;
 * - une étape finalisée est protégée contre l'écrasement accidentel ;
 * - les situations sont recopiées dans le journal individuel sans effacer les notes manuelles ;
 * - les évaluations officielles font partie du suivi via un index avec lien PDF ;
 * - les lectures ne réécrivent rien inutilement ;
 * - synchronisation immédiate lors des écritures + réconciliation globale possible.
 */

const SUIVI_CONFIG = Object.freeze({
  TEMPLATE_ID: '1C6Ur7UL_4EpOvVvm9ivSPxzKcVhxlZcDkDstmZ0_zLc',
  TZ: 'Europe/Paris',
  STATUS_SHEET: 'Suivi étapes',
  STATUS_CACHE_KEY: 'SUIVI_STATUS_V2',
  STATUS_CACHE_SECONDS: 60,
  EVALUATION_INDEX_TAB: 'Évaluations officielles',
  SITUATION_MARKER_PREFIX: 'AUTO-SITUATION:',
  TECHNICAL_MARKER_COLUMN: 26
});

const SUIVI_STEPS = Object.freeze({
  premier_jour: {
    label: '1er jour',
    tab: '1er jour',
    summaryRow: 17,
    special: 'FIRST_DAY'
  },
  premiere_semaine: {
    label: '1ère semaine',
    tab: '1ère semaine',
    summaryRow: 18
  },
  fin_doublure: {
    label: 'Fin de doublure',
    tab: 'fin de doublure',
    summaryRow: 19
  },
  suivi_1_mois: {
    label: 'Suivi à 1 mois',
    tab: 'Suivi à 1 mois',
    summaryRow: 20
  },
  suivi_3_mois: {
    label: 'Suivi à 3 mois',
    tab: 'Suivi à 3 mois',
    summaryRow: 21
  },
  suivi_6_mois: {
    label: 'Suivi à 6 mois',
    tab: 'Suivi à 6 mois',
    summaryRow: 22
  }
});

const SUIVI_TEMPLATE_TABS = Object.freeze([
  'fiche brancardier',
  '1er jour',
  '1ère semaine',
  'fin de doublure',
  'Suivi à 1 mois',
  'Suivi à 3 mois',
  'Suivi à 6 mois'
]);

/* ========================= API MÉTIER ========================= */

function getFollowup_(agentId, rawStep) {
  const id = clean_(agentId);
  const step = normalizeFollowupStep_(rawStep);
  if (!id) throw new Error('ID_AGENT_MANQUANT');
  if (!step || !SUIVI_STEPS[step]) throw new Error('ETAPE_SUIVI_INVALIDE');

  if (step === 'premier_jour') {
    return {
      id_agent: id,
      etape: step,
      type: 'PREMIER_JOUR',
      first_day: getFirstDay_(id)
    };
  }

  const context = followupContext_(id, step);
  return buildFollowupPayload_(context.agent, step, context.sheet);
}

function saveFollowup_(p, principal) {
  const id = clean_(p && p.id_agent);
  const step = normalizeFollowupStep_(p && p.etape);
  if (!id) throw new Error('ID_AGENT_MANQUANT');
  if (!step || !SUIVI_STEPS[step]) throw new Error('ETAPE_SUIVI_INVALIDE');
  if (step === 'premier_jour') throw new Error('UTILISER_SAVE_FIRST_DAY');

    const context = followupContext_(id, step);
    const current = buildFollowupPayload_(context.agent, step, context.sheet);
    const finalize = p.finalize === true || String(p.finalize || '') === '1';

    if (current.statut === 'TERMINE') {
      throw new Error('SUIVI_ETAPE_TERMINEE_IMMUABLE');
    }

    const incoming = Array.isArray(p.items) ? p.items : [];
    const allowedRows = {};
    current.items.forEach(item => allowedRows[String(item.row)] = item);

    const normalized = incoming.map(item => {
      const row = Number(item.row || 0);
      const source = allowedRows[String(row)];
      if (!source) throw new Error('LIGNE_SUIVI_INVALIDE');
      const level = clean_(item.niveau);
      if (level && source.levels.indexOf(level) < 0) throw new Error('NIVEAU_SUIVI_INVALIDE');
      const observation = boundedText_(item.observation, 5000, 'OBSERVATION_TROP_LONGUE');
      return {row, level, observation, source};
    });

    if (finalize) {
      if (normalized.length !== current.items.length) throw new Error('SUIVI_INCOMPLET');
      normalized.forEach(item => {
        if (!item.level) throw new Error('SUIVI_INCOMPLET');
        if (followupLevelNeedsObservation_(item.level) && !item.observation) {
          throw new Error('OBSERVATION_REQUISE_POUR_NIVEAU');
        }
      });
    }

    normalized.forEach(item => {
      const selectedIndex = item.level ? item.source.levels.indexOf(item.level) : -1;
      context.sheet.getRange(item.row, 2, 1, 3).setValues([[
        selectedIndex === 0 ? '☒' : '☐',
        selectedIndex === 1 ? '☒' : '☐',
        selectedIndex === 2 ? '☒' : '☐'
      ]]);
      context.sheet.getRange(item.row, 5).setValue(safeSheetText_(item.observation));
    });

    saveFollowupBilan_(context.sheet, current, p.bilan || {}, p.choices || []);

    const evaluator = principal
      ? clean_(principal.prenom + ' ' + principal.nom)
      : boundedText_(p.evaluateur, 250, 'EVALUATEUR_TROP_LONG');
    const validationDate = clean_(p.date_validation || formatDateForClient_(new Date()));

    SpreadsheetApp.flush();
    const afterWrite = buildFollowupPayload_(context.agent, step, context.sheet);
    let status = afterWrite.has_data ? 'BROUILLON' : 'A_FAIRE';

    if (finalize) {
      if (!evaluator) throw new Error('EVALUATEUR_REQUIS');
      if (!parseIsoDate_(validationDate)) throw new Error('DATE_VALIDATION_INVALIDE');
      writeFollowupValidation_(context.sheet, current.validation, evaluator, validationDate);
      writeFollowupSummaryDate_(context.ss, step, validationDate);
      status = 'TERMINE';
    }

    upsertFollowupStatus_(id, step, status, finalize ? validationDate : '', evaluator);
    SpreadsheetApp.flush();

    const verified = buildFollowupPayload_(context.agent, step, context.sheet);
    if (!verified || verified.statut !== status) throw new Error('VERIFICATION_SUIVI_ECHOUEE');

    return {
      ok: true,
      verified: true,
      message: status === 'TERMINE'
        ? 'Étape validée, enregistrée et protégée.'
        : 'Brouillon enregistré et vérifié.',
      followup: verified
    };
}

function getFollowupOverview_(agentId) {
  const id = clean_(agentId);
  if (!id) throw new Error('ID_AGENT_MANQUANT');
  const agent = getAgent_(id);
  if (!agent) throw new Error('AGENT_INTROUVABLE');

  const statusRows = readFollowupStatusRows_().filter(x => x.id_agent === id);
  const byStep = {};
  statusRows.forEach(x => byStep[x.etape] = x);

  const steps = Object.keys(SUIVI_STEPS).map(step => {
    if (step === 'premier_jour') {
      const first = getFirstDay_(id);
      return {
        etape: step,
        label: SUIVI_STEPS[step].label,
        statut: first.statut,
        date_validation: first.date_validation || '',
        modified_at: first.modified_at || ''
      };
    }
    const stored = byStep[step] || null;
    return {
      etape: step,
      label: SUIVI_STEPS[step].label,
      statut: stored ? stored.statut : 'A_FAIRE',
      date_validation: stored ? stored.date_validation : '',
      modified_at: stored ? stored.modifie_le : '',
      evaluateur: stored ? stored.evaluateur : ''
    };
  });

  let evaluations = [];
  try { evaluations = listEvaluations_(id); } catch (_) {}
  const official = evaluations.filter(x => x.statut === 'VALIDE');

  return {
    id_agent: id,
    agent: {
      nom: agent.nom,
      prenom: agent.prenom,
      matricule: agent.matricule,
      fichier_suivi_url: agent.fichier_brouillon_url
    },
    etapes: steps,
    evaluations: {
      total: official.length,
      derniere: official.length ? official[0] : null
    },
    situations: { total: countAgentSituations_(id) }
  };
}

/* ========================= STRUCTURE DU FICHIER AGENT ========================= */

function ensureFollowupStructureForFile_(spreadsheetId) {
  const id = clean_(spreadsheetId);
  if (!id) throw new Error('FICHIER_SUIVI_MANQUANT');
  const target = SpreadsheetApp.openById(id);

  const missing = SUIVI_TEMPLATE_TABS.filter(name => !target.getSheetByName(name));
  const missingComplement = !target.getSheetByName('Suivi complémentaire') && !target.getSheetByName('Événements et observations');

  if (missing.length || missingComplement) {
    const template = SpreadsheetApp.openById(SUIVI_CONFIG.TEMPLATE_ID);
    missing.forEach(name => {
      const source = template.getSheetByName(name);
      if (!source) throw new Error('ONGLET_MODELE_MANQUANT: ' + name);
      source.copyTo(target).setName(name);
    });
    if (missingComplement) {
      const source = template.getSheetByName('Suivi complémentaire');
      if (source) source.copyTo(target).setName('Suivi complémentaire');
    }
  }

  ensureEvaluationIndexSheet_(target);
  return target;
}

function followupContext_(agentId, step) {
  const agent = getAgent_(agentId);
  if (!agent) throw new Error('AGENT_INTROUVABLE');
  if (!agent.fichier_brouillon_id) throw new Error('FICHIER_SUIVI_MANQUANT');

  let ss = SpreadsheetApp.openById(agent.fichier_brouillon_id);
  const conf = SUIVI_STEPS[step];
  let sheet = ss.getSheetByName(conf.tab);
  if (!sheet) {
    ss = ensureFollowupStructureForFile_(agent.fichier_brouillon_id);
    sheet = ss.getSheetByName(conf.tab);
  }
  if (!sheet) throw new Error('ONGLET_SUIVI_MANQUANT: ' + conf.tab);
  return {agent, ss, sheet};
}

function syncAgentIdentityToFollowup_(agent, ss) {
  const sh = ss.getSheetByName('fiche brancardier');
  if (!sh) throw new Error('ONGLET_FICHE_BRANCARDIER_MANQUANT');

  sh.getRange('C5').setValue(safeSheetText_(agent.nom));
  sh.getRange('C6').setValue(safeSheetText_(agent.prenom));
  sh.getRange('C7').setValue(safeSheetText_(agent.telephone));
  sh.getRange('C8').setValue(safeSheetText_(agent.matricule));
  const arrival = parseIsoDate_(agent.date_arrivee);
  if (arrival) sh.getRange('C9').setValue(arrival).setNumberFormat('dd/MM/yyyy');
  else sh.getRange('C9').clearContent();
  sh.getRange('A12').setValue(safeSheetText_(agent.experiences));

  try {
    DriveApp.getFileById(agent.fichier_brouillon_id)
      .setName(('SUIVI - ' + agent.prenom + ' ' + agent.nom).trim());
  } catch (_) {}
}

/* ========================= LECTURE GÉNÉRIQUE D'UNE ÉTAPE ========================= */

function buildFollowupPayload_(agent, step, sh) {
  const lastRow = Math.max(1, sh.getLastRow());
  const values = sh.getRange(1, 1, lastRow, 6).getDisplayValues();
  const levels = detectFollowupLevels_(values);
  if (levels.length !== 3) throw new Error('NIVEAUX_SUIVI_INTROUVABLES');

  let currentSection = '';
  let bilanStart = 0;
  let validationHeading = 0;
  let validationRow = 0;
  const items = [];

  for (let i = 0; i < values.length; i++) {
    const row = i + 1;
    const a = clean_(values[i][0]);
    const bcd = values[i].slice(1, 4);
    const hasCheckbox = bcd.some(isFollowupCheckboxCell_);

    if (/^BILAN\b/i.test(a)) bilanStart = row;
    if (/^VALIDATION\b/i.test(a)) validationHeading = row;
    if (normalizeFollowupText_(a).indexOf('chef d equipe') >= 0 && normalizeFollowupText_(a).indexOf('nom') >= 0) {
      validationRow = row;
    }

    if (/^\d+\./.test(a) && !hasCheckbox) currentSection = a;

    if (a && hasCheckbox && row > 4 && (!bilanStart || row < bilanStart)) {
      const checked = bcd.map(isFollowupChecked_);
      const selected = checked.findIndex(Boolean);
      items.push({
        row,
        section: currentSection,
        libelle: a,
        levels: levels.slice(),
        niveau: selected >= 0 ? levels[selected] : '',
        observation: clean_(values[i][4])
      });
    }
  }

  const bilanEnd = validationHeading || validationRow || lastRow + 1;
  const bilan = readFollowupBilan_(sh, values, bilanStart, bilanEnd);
  const validation = readFollowupValidation_(sh, validationRow);
  const anyData = items.some(x => x.niveau || x.observation) || followupBilanPayloadHasData_(bilan);
  const stored = getStoredFollowupStatus_(agent.id_agent, step);
  let status = stored ? stored.statut : (anyData ? 'BROUILLON' : 'A_FAIRE');
  if (validation.evaluateur && validation.date_validation) status = 'TERMINE';

  return {
    id_agent: agent.id_agent,
    etape: step,
    label: SUIVI_STEPS[step].label,
    statut: status,
    has_data: anyData,
    levels,
    items,
    completed: items.filter(x => x.niveau).length,
    total: items.length,
    bilan,
    validation,
    modified_at: stored ? stored.modifie_le : ''
  };
}

function detectFollowupLevels_(values) {
  for (let i = 0; i < Math.min(values.length, 12); i++) {
    const cells = values[i].slice(1, 4).map(clean_);
    const nonEmpty = cells.filter(Boolean);
    if (nonEmpty.length >= 2 && !cells.some(isFollowupCheckboxCell_)) {
      return cells;
    }
  }
  return [];
}

function isFollowupCheckboxCell_(value) {
  const s = clean_(value).toUpperCase();
  return s === '☐' || s === '☒' || s === 'TRUE' || s === 'FALSE' || s === 'X';
}

function isFollowupChecked_(value) {
  const s = clean_(value).toUpperCase();
  return s === '☒' || s === 'TRUE' || s === 'X' || s === '1' || s === 'OUI';
}

function followupLevelNeedsObservation_(level) {
  const n = normalizeFollowupText_(level);
  return n.indexOf('en cours') >= 0 || n.indexOf('a consolider') >= 0 || n.indexOf('non acquis') >= 0;
}

/* ========================= BILAN / VALIDATION ========================= */

function readFollowupBilan_(sh, values, startRow, endRow) {
  if (!startRow) return {fields: [], choices: []};
  const fields = [];
  const choices = [];

  for (let row = startRow + 1; row < endRow; row++) {
    const data = values[row - 1] || [];
    const a = clean_(data[0]);
    const b = clean_(data[1]);
    const c = clean_(data[2]);

    if (a && !/^BILAN\b/i.test(a) && !/^VALIDATION\b/i.test(a)) {
      const target = findWritableFollowupCell_(sh, row);
      fields.push({
        row,
        label: a,
        value: target ? clean_(target.getDisplayValue()) : '',
        target_a1: target ? target.getA1Notation() : ''
      });
    } else if (!a && isFollowupCheckboxCell_(b) && c) {
      choices.push({row, label: c, selected: isFollowupChecked_(b)});
    }
  }
  return {fields, choices};
}

function findWritableFollowupCell_(sh, row) {
  const rowRange = sh.getRange(row, 1, 1, Math.min(10, sh.getMaxColumns()));
  const merged = rowRange.getMergedRanges();
  let labelEnd = 1;
  merged.forEach(r => {
    if (r.getRow() === row && r.getColumn() <= 1 && r.getLastColumn() >= 1) {
      labelEnd = Math.max(labelEnd, r.getLastColumn());
    }
  });

  if (labelEnd < Math.min(10, sh.getMaxColumns())) {
    return sh.getRange(row, labelEnd + 1);
  }

  const next = row + 1;
  if (next <= sh.getMaxRows() && !clean_(sh.getRange(next, 1).getDisplayValue())) {
    return sh.getRange(next, 1);
  }
  return null;
}

function saveFollowupBilan_(sh, current, incomingFields, incomingChoices) {
  const fields = incomingFields && typeof incomingFields === 'object' ? incomingFields : {};
  current.bilan.fields.forEach(field => {
    const key = String(field.row);
    if (!Object.prototype.hasOwnProperty.call(fields, key)) return;
    const value = boundedText_(fields[key], 10000, 'BILAN_TROP_LONG');
    if (field.target_a1) sh.getRange(field.target_a1).setValue(safeSheetText_(value));
  });

  const allowedChoices = {};
  current.bilan.choices.forEach(x => allowedChoices[String(x.row)] = x);
  if (Array.isArray(incomingChoices)) {
    incomingChoices.forEach(choice => {
      const row = Number(choice.row || 0);
      if (!allowedChoices[String(row)]) throw new Error('CHOIX_BILAN_INVALIDE');
      sh.getRange(row, 2).setValue(choice.selected ? '☒' : '☐');
    });
  }
}

function followupBilanPayloadHasData_(bilan) {
  return Boolean(bilan && (
    bilan.fields.some(x => clean_(x.value)) ||
    bilan.choices.some(x => x.selected)
  ));
}

function readFollowupValidation_(sh, row) {
  if (!row) return {row: 0, evaluateur: '', date_validation: ''};
  const evaluator = clean_(sh.getRange(row, 2).getDisplayValue());
  const rawDate = sh.getRange(row, 4).getValue();
  return {
    row,
    evaluateur: evaluator,
    date_validation: formatDateForClient_(rawDate)
  };
}

function writeFollowupValidation_(sh, validation, evaluator, isoDate) {
  let row = validation && validation.row ? validation.row : 0;
  if (!row) {
    const last = sh.getLastRow();
    const values = sh.getRange(1, 1, last, 1).getDisplayValues();
    for (let i = 0; i < values.length; i++) {
      const text = normalizeFollowupText_(values[i][0]);
      if (text.indexOf('chef d equipe') >= 0 && text.indexOf('nom') >= 0) {
        row = i + 1;
        break;
      }
    }
  }
  if (!row) throw new Error('ZONE_VALIDATION_INTROUVABLE');
  sh.getRange(row, 2).setValue(safeSheetText_(evaluator));
  const d = parseIsoDate_(isoDate);
  sh.getRange(row, 4).setValue(d || isoDate);
  if (d) sh.getRange(row, 4).setNumberFormat('dd/MM/yyyy');
}

/* ========================= STATUTS CENTRALISÉS ========================= */

function followupStatusSheet_() {
  const ss = SpreadsheetApp.openById(CONFIG.SOURCE_ID);
  let sh = ss.getSheetByName(SUIVI_CONFIG.STATUS_SHEET);
  const headers = ['ID agent','Étape','Statut','Date validation','Modifié le','Évaluateur'];

  if (!sh) {
    sh = ss.insertSheet(SUIVI_CONFIG.STATUS_SHEET);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
    return sh;
  }

  const current = sh.getLastColumn() >= headers.length
    ? sh.getRange(1, 1, 1, headers.length).getDisplayValues()[0]
    : [];
  if (headers.some((h, i) => clean_(current[i]) !== h)) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function readFollowupStatusRows_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(SUIVI_CONFIG.STATUS_CACHE_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch (_) {}
  }

  const sh = followupStatusSheet_();
  if (sh.getLastRow() < 2) return [];
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues()
    .filter(r => clean_(r[0]) && clean_(r[1]))
    .map(r => ({
      id_agent: clean_(r[0]),
      etape: normalizeFollowupStep_(r[1]),
      statut: clean_(r[2]) || 'A_FAIRE',
      date_validation: formatDateForClient_(r[3]),
      modifie_le: formatDateTimeForClient_(r[4]),
      evaluateur: clean_(r[5])
    }));

  try {
    cache.put(SUIVI_CONFIG.STATUS_CACHE_KEY, JSON.stringify(rows), SUIVI_CONFIG.STATUS_CACHE_SECONDS);
  } catch (_) {}
  return rows;
}

function getStoredFollowupStatus_(id, step) {
  return readFollowupStatusRows_().find(x => x.id_agent === id && x.etape === step) || null;
}

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

function writeFollowupSummaryDate_(ss, step, isoDate) {
  const conf = SUIVI_STEPS[step];
  if (!conf || !conf.summaryRow) return;
  const sh = ss.getSheetByName('fiche brancardier');
  if (!sh) return;
  const d = parseIsoDate_(isoDate);
  sh.getRange(conf.summaryRow, 4).setValue(d || isoDate);
  if (d) sh.getRange(conf.summaryRow, 4).setNumberFormat('dd/MM/yyyy');
}

function syncFollowupSummary_(agentId) {
  const id = clean_(agentId);
  const agent = getAgent_(id);
  if (!agent || !agent.fichier_brouillon_id) return;
  const ss = ensureFollowupStructureForFile_(agent.fichier_brouillon_id);
  syncAgentIdentityToFollowup_(agent, ss);

  const first = getFirstDay_(id);
  if (first.date_validation) writeFollowupSummaryDate_(ss, 'premier_jour', first.date_validation);

  readFollowupStatusRows_()
    .filter(x => x.id_agent === id && x.statut === 'TERMINE' && x.date_validation)
    .forEach(x => writeFollowupSummaryDate_(ss, x.etape, x.date_validation));
}

/* ========================= SITUATIONS / ÉVÉNEMENTS ========================= */

function countAgentSituations_(agentId) {
  const sh = situationsSheet_();
  if (sh.getLastRow() < 2) return 0;
  return sh.getRange(2, 1, sh.getLastRow() - 1, 11).getValues()
    .filter(r => clean_(r[1]) === agentId).length;
}

function syncAgentSituations_(agentId) {
  const id = clean_(agentId);
  const agent = getAgent_(id);
  if (!agent || !agent.fichier_brouillon_id) return;
  const ss = ensureFollowupStructureForFile_(agent.fichier_brouillon_id);
  const sh = ss.getSheetByName('Événements et observations') || ss.getSheetByName('Suivi complémentaire');
  if (!sh) return;

  const headerRow = findSituationHeaderRow_(sh);
  const markerCol = SUIVI_CONFIG.TECHNICAL_MARKER_COLUMN;
  const maxRow = Math.max(headerRow + 1, sh.getLastRow());
  if (maxRow > headerRow) {
    const markers = sh.getRange(headerRow + 1, markerCol, maxRow - headerRow, 1).getDisplayValues();
    for (let i = markers.length - 1; i >= 0; i--) {
      if (clean_(markers[i][0]).indexOf(SUIVI_CONFIG.SITUATION_MARKER_PREFIX) === 0) {
        sh.deleteRow(headerRow + 1 + i);
      }
    }
  }

  const source = situationsSheet_();
  if (source.getLastRow() < 2) return;
  const rows = source.getRange(2, 1, source.getLastRow() - 1, 11).getValues()
    .filter(r => clean_(r[1]) === id);

  rows.forEach(r => {
    const situationId = clean_(r[0]);
    const impact = clean_(r[4]);
    const contexte = clean_(r[5]);
    const consequence = clean_(r[6]);
    const fait = clean_(r[7]);
    const responsable = clean_(r[8]);
    const created = r[10] instanceof Date ? r[10] : new Date();
    const title = impact || 'Situation / événement';
    const note = [
      fait,
      contexte ? 'Contexte : ' + contexte : '',
      consequence ? 'Conséquence : ' + consequence : ''
    ].filter(Boolean).join('\n');

    const row = Math.max(headerRow + 1, sh.getLastRow() + 1);
    sh.getRange(row, 1, 1, 4).setValues([[
      created,
      safeSheetText_(responsable),
      safeSheetText_(title),
      safeSheetText_(note)
    ]]);
    sh.getRange(row, 1).setNumberFormat('dd/MM/yyyy');
    sh.getRange(row, markerCol).setValue(SUIVI_CONFIG.SITUATION_MARKER_PREFIX + situationId);
  });
}

function findSituationHeaderRow_(sh) {
  const last = Math.min(Math.max(1, sh.getLastRow()), 30);
  const values = sh.getRange(1, 1, last, 4).getDisplayValues();
  for (let i = 0; i < values.length; i++) {
    if (normalizeFollowupText_(values[i][0]) === 'date') return i + 1;
  }
  const row = 4;
  sh.getRange(row, 1, 1, 4).setValues([['DATE','AUTEUR','INTITULÉ','NOTE / ÉLÉMENT DE SUIVI']]);
  return row;
}

/* ========================= ÉVALUATIONS OFFICIELLES ========================= */

function ensureEvaluationIndexSheet_(ss) {
  let sh = ss.getSheetByName(SUIVI_CONFIG.EVALUATION_INDEX_TAB);
  const headers = [
    'Date évaluation','Version','Évaluateur','Statut','PDF officiel',
    'Empreinte SHA-256','ID évaluation'
  ];
  if (!sh) {
    sh = ss.insertSheet(SUIVI_CONFIG.EVALUATION_INDEX_TAB);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
    return sh;
  }

  const current = sh.getLastColumn() >= headers.length
    ? sh.getRange(1, 1, 1, headers.length).getDisplayValues()[0]
    : [];
  if (headers.some((h, i) => clean_(current[i]) !== h)) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function syncAgentEvaluationIndex_(agentId) {
  const id = clean_(agentId);
  const agent = getAgent_(id);
  if (!agent || !agent.fichier_brouillon_id) return;
  const ss = ensureFollowupStructureForFile_(agent.fichier_brouillon_id);
  const sh = ensureEvaluationIndexSheet_(ss);

  const evals = listEvaluations_(id)
    .filter(x => x.statut === 'VALIDE')
    .sort((a, b) => Number(a.version || 0) - Number(b.version || 0));

  if (sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 7).clearContent();
  }
  if (!evals.length) return;

  const values = evals.map(ev => [
    parseIsoDate_(ev.date_evaluation) || ev.date_evaluation || '',
    Number(ev.version || 0),
    safeSheetText_(ev.evaluateur),
    safeSheetText_(ev.statut),
    safeSheetText_(ev.url_document),
    safeSheetText_(ev.sha256),
    safeSheetText_(ev.id_evaluation)
  ]);
  sh.getRange(2, 1, values.length, 7).setValues(values);
  sh.getRange(2, 1, values.length, 1).setNumberFormat('dd/MM/yyyy');
  sh.autoResizeColumns(1, 7);
}

/* ========================= RÉCONCILIATION GLOBALE ========================= */

function METTRE_A_JOUR_SUIVIS() {
  const sh = sourceSheet_();
  if (sh.getLastRow() < 2) return {ok:true, agents:0};
  const ids = sh.getRange(2, COL.ID, sh.getLastRow() - 1, 1).getDisplayValues()
    .map(r => clean_(r[0])).filter(Boolean);
  let done = 0;
  const errors = [];

  ids.forEach(id => {
    try {
      const agent = getAgent_(id);
      if (!agent || !agent.fichier_brouillon_id) return;
      const ss = ensureFollowupStructureForFile_(agent.fichier_brouillon_id);
      syncAgentIdentityToFollowup_(agent, ss);
      syncFollowupSummary_(id);
      syncAgentSituations_(id);
      syncAgentEvaluationIndex_(id);
      done++;
    } catch (err) {
      errors.push({id_agent:id, erreur:String(err && err.message ? err.message : err)});
    }
  });

  return {ok:errors.length===0, agents:done, erreurs:errors};
}

function INSTALLER_DECLENCHEUR_SUIVI() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'METTRE_A_JOUR_SUIVIS')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('METTRE_A_JOUR_SUIVIS')
    .timeBased()
    .everyDays(1)
    .atHour(2)
    .create();
  return {ok:true, message:'Réconciliation quotidienne du suivi installée.'};
}

function TESTER_SUIVI_COMPLET() {
  const template = SpreadsheetApp.openById(SUIVI_CONFIG.TEMPLATE_ID);
  DriveApp.getFolderById(CONFIG.DEST_FOLDER_ID);
  sourceSheet_();
  SUIVI_TEMPLATE_TABS.forEach(name => {
    if (!template.getSheetByName(name)) throw new Error('ONGLET_MODELE_MANQUANT: ' + name);
  });
  if (!template.getSheetByName('Suivi complémentaire')) {
    throw new Error('ONGLET_MODELE_MANQUANT: Suivi complémentaire');
  }
  followupStatusSheet_();
  return {
    ok:true,
    template:template.getName(),
    etapes:Object.keys(SUIVI_STEPS),
    source:CONFIG.SOURCE_SHEET
  };
}

/* ========================= NORMALISATION ========================= */

function normalizeFollowupStep_(value) {
  const n = normalizeFollowupText_(value).replace(/[^a-z0-9]/g, '');
  const aliases = {
    premierjour:'premier_jour',
    '1erjour':'premier_jour',
    premieresemaine:'premiere_semaine',
    '1eresemaine':'premiere_semaine',
    findedoublure:'fin_doublure',
    suivi1mois:'suivi_1_mois',
    '1mois':'suivi_1_mois',
    suivi3mois:'suivi_3_mois',
    '3mois':'suivi_3_mois',
    suivi6mois:'suivi_6_mois',
    '6mois':'suivi_6_mois'
  };
  return aliases[n] || clean_(value);
}

function normalizeFollowupText_(value) {
  return clean_(value)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
