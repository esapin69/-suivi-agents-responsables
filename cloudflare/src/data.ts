import type {
  DocumentRow,
  Env,
  FinalEvaluationRow,
  ObservationRow,
  Principal,
  SelfSectionRow,
  SignatureRow,
  TraineeRow,
} from "./types";
import { ApiError } from "./http";
import { randomId, sha256Text } from "./security";

export const CATEGORY_LABELS: Record<string, string> = {
  AUTONOMIE: "Autonomie",
  TECHNIQUE_MANUTENTION: "Technique et manutention",
  SECURITE_HYGIENE: "Sécurité et hygiène",
  COMMUNICATION: "Communication",
  ORGANISATION: "Organisation",
  COMPORTEMENT_PROFESSIONNEL: "Comportement professionnel",
  AUTRE: "Autre observation",
};

export const RATING_LABELS: Record<string, string> = {
  autonomy: "Autonomie",
  techniqueHandling: "Technique et manutention",
  safetyHygiene: "Sécurité et hygiène",
  communication: "Communication",
  organization: "Organisation",
  professionalBehavior: "Comportement professionnel",
};

export type RecordSnapshot = {
  trainee: TraineeRow;
  selfSection: SelfSectionRow | null;
  observations: ObservationRow[];
  finalEvaluation: FinalEvaluationRow | null;
  signatures: SignatureRow[];
  documents: DocumentRow[];
};

export async function getTrainee(env: Env, id: string): Promise<TraineeRow> {
  const trainee = await env.DB.prepare("SELECT * FROM trainees WHERE id = ?").bind(id).first<TraineeRow>();
  if (!trainee) throw new ApiError("STAGIAIRE_INTROUVABLE", "Ce dossier stagiaire n’existe pas.", 404);
  return trainee;
}

export async function getCurrentSnapshot(env: Env, id: string): Promise<RecordSnapshot> {
  const trainee = await getTrainee(env, id);
  const version = trainee.record_version;
  const [selfSection, observations, finalEvaluation, signatures, documents] = await Promise.all([
    env.DB.prepare("SELECT * FROM trainee_self_sections WHERE trainee_id = ? AND record_version = ?").bind(id, version).first<SelfSectionRow>(),
    env.DB.prepare("SELECT * FROM observations WHERE trainee_id = ? AND record_version <= ? ORDER BY observed_on DESC, created_at DESC").bind(id, version).all<ObservationRow>(),
    env.DB.prepare("SELECT * FROM final_evaluations WHERE trainee_id = ? AND record_version = ?").bind(id, version).first<FinalEvaluationRow>(),
    env.DB.prepare("SELECT * FROM signatures WHERE trainee_id = ? AND (record_version = ? OR scope_type = 'OBSERVATION') ORDER BY created_at").bind(id, version).all<SignatureRow>(),
    env.DB.prepare("SELECT * FROM documents WHERE trainee_id = ? ORDER BY record_version DESC").bind(id).all<DocumentRow>(),
  ]);
  return {
    trainee,
    selfSection: selfSection || null,
    observations: observations.results,
    finalEvaluation: finalEvaluation || null,
    signatures: signatures.results,
    documents: documents.results,
  };
}

export function assertOpenVersion(trainee: TraineeRow, expectedVersion: number): void {
  if (trainee.status !== "OPEN") throw new ApiError("DOSSIER_CLOTURE", "Ce dossier est clôturé et ne peut plus être modifié.", 409);
  if (trainee.record_version !== expectedVersion) {
    throw new ApiError("VERSION_DEPASSEE", "La fiche a été modifiée ailleurs. Rechargez-la avant de continuer.", 409, { currentVersion: trainee.record_version });
  }
}

export function publicSnapshot(snapshot: RecordSnapshot, principal?: Principal, traineeView = false): Record<string, unknown> {
  const signatures = snapshot.signatures.map(signature => ({
    id: signature.id,
    scopeType: signature.scope_type,
    scopeId: signature.scope_id,
    payloadHash: signature.payload_hash,
    signerName: signature.signer_name,
    signerRole: signature.signer_role,
    ...(traineeView ? {} : { signerUserId: signature.signer_user_id }),
    createdAt: signature.created_at,
  }));
  return {
    trainee: mapTrainee(snapshot.trainee, traineeView),
    selfSection: snapshot.selfSection ? {
      expectations: snapshot.selfSection.expectations,
      progress: snapshot.selfSection.progress,
      feedback: snapshot.selfSection.feedback,
      comments: snapshot.selfSection.comments,
      updatedAt: snapshot.selfSection.updated_at,
    } : null,
    observations: snapshot.observations.map(row => ({
      id: row.id,
      authorUserId: row.author_user_id,
      authorName: row.author_name,
      category: row.category,
      categoryLabel: CATEGORY_LABELS[row.category] || row.category,
      recordVersion: row.record_version,
      observedOn: row.observed_on,
      content: row.content,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      signed: signatures.some(signature => signature.scopeType === "OBSERVATION" && signature.scopeId === row.id),
      canEdit: Boolean(principal && principal.id === row.author_user_id && row.record_version === snapshot.trainee.record_version && snapshot.trainee.status === "OPEN" && !signatures.some(signature => signature.scopeType === "OBSERVATION" && signature.scopeId === row.id)),
    })),
    finalEvaluation: snapshot.finalEvaluation ? {
      ratings: safeJson(snapshot.finalEvaluation.ratings_json),
      strengths: snapshot.finalEvaluation.strengths,
      improvements: snapshot.finalEvaluation.improvements,
      summary: snapshot.finalEvaluation.summary,
      status: snapshot.finalEvaluation.status,
      updatedAt: snapshot.finalEvaluation.updated_at,
    } : null,
    signatures,
    documents: snapshot.documents.map(document => ({
      id: document.id,
      version: document.record_version,
      sha256: document.sha256,
      byteLength: document.byte_length,
      createdAt: document.created_at,
      downloadUrl: `/v2/trainees/${snapshot.trainee.id}/documents/${document.record_version}`,
    })),
    capabilities: traineeView ? {
      editSelfSection: snapshot.trainee.status === "OPEN",
      signSelfSection: snapshot.trainee.status === "OPEN",
      signFinalEvaluation: snapshot.trainee.status === "OPEN" && Boolean(snapshot.finalEvaluation),
    } : {
      addObservation: snapshot.trainee.status === "OPEN",
      editFinalEvaluation: snapshot.trainee.status === "OPEN" && Boolean(principal && ["ADMIN", "CHEF"].includes(principal.role)),
      close: snapshot.trainee.status === "OPEN" && Boolean(principal && ["ADMIN", "CHEF"].includes(principal.role)),
      createVersion: snapshot.trainee.status === "CLOSED" && Boolean(principal && ["ADMIN", "CHEF"].includes(principal.role)),
      administer: principal?.role === "ADMIN",
    },
  };
}

export function mapTrainee(row: TraineeRow, traineeView = false): Record<string, unknown> {
  return {
    id: row.id,
    reference: row.public_ref,
    firstName: row.first_name,
    lastName: row.last_name,
    displayName: `${row.first_name} ${row.last_name}`.trim(),
    ...(traineeView ? {} : { email: row.email, phone: row.phone }),
    school: row.school,
    startDate: row.start_date,
    endDate: row.end_date,
    ...(traineeView ? {} : { tutorUserId: row.tutor_user_id }),
    tutorName: row.tutor_name,
    arrivalNotes: row.arrival_notes,
    status: row.status,
    recordVersion: row.record_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}

export async function audit(
  env: Env,
  input: {
    traineeId?: string;
    recordVersion?: number;
    actorType: "USER" | "TRAINEE" | "SYSTEM";
    actorId: string;
    actorName: string;
    action: string;
    targetType: string;
    targetId: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_events
      (id, trainee_id, record_version, actor_type, actor_id, actor_name, action, target_type, target_id, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    randomId("evt"),
    input.traineeId || null,
    input.recordVersion || null,
    input.actorType,
    input.actorId,
    input.actorName,
    input.action,
    input.targetType,
    input.targetId,
    JSON.stringify(input.details || {}),
    new Date().toISOString(),
  ).run();
}

export async function observationPayloadHash(row: ObservationRow): Promise<string> {
  return sha256Text(stableStringify({
    id: row.id,
    traineeId: row.trainee_id,
    recordVersion: row.record_version,
    authorUserId: row.author_user_id,
    authorName: row.author_name,
    category: row.category,
    observedOn: row.observed_on,
    content: row.content,
    createdAt: row.created_at,
  }));
}

export async function selfSectionPayloadHash(row: SelfSectionRow): Promise<string> {
  return sha256Text(stableStringify({
    traineeId: row.trainee_id,
    recordVersion: row.record_version,
    expectations: row.expectations,
    progress: row.progress,
    feedback: row.feedback,
    comments: row.comments,
  }));
}

export async function finalEvaluationPayloadHash(row: FinalEvaluationRow): Promise<string> {
  return sha256Text(stableStringify({
    id: row.id,
    traineeId: row.trainee_id,
    recordVersion: row.record_version,
    ratings: safeJson(row.ratings_json),
    strengths: row.strengths,
    improvements: row.improvements,
    summary: row.summary,
  }));
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function safeJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return {}; }
}
