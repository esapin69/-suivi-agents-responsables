export type Role = "ADMIN" | "CHEF" | "AGENT";

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  DOCUMENTS: R2Bucket;
  SESSION_SECRET: string;
  APPS_SCRIPT_URL?: string;
  APPS_SCRIPT_KEY?: string;
  LOGIN_IP_LIMITER: RateLimiter;
  LOGIN_GLOBAL_LIMITER: RateLimiter;
  SHARE_LINK_LIMITER: RateLimiter;
}

export type AccessMap = Record<string, boolean>;

export interface Principal {
  id: string;
  firstName: string;
  lastName: string;
  displayName: string;
  position: string;
  role: Role;
  source: "legacy";
  sessionVersion: string;
  access: AccessMap;
}

export interface TraineePrincipal {
  kind: "trainee";
  linkId: string;
  traineeId: string;
  expiresAt: number;
}

export interface UserRow {
  id: string;
  first_name: string;
  last_name: string;
  display_name: string;
  position: string;
  last_verified_at: string;
  created_at: string;
  updated_at: string;
}

export interface TraineeRow {
  id: string;
  public_ref: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  school: string;
  start_date: string;
  end_date: string;
  tutor_user_id: string | null;
  tutor_name: string;
  arrival_notes: string;
  status: "OPEN" | "CLOSED";
  record_version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface SelfSectionRow {
  trainee_id: string;
  record_version: number;
  expectations: string;
  progress: string;
  feedback: string;
  comments: string;
  updated_at: string;
}

export interface ObservationRow {
  id: string;
  trainee_id: string;
  record_version: number;
  author_user_id: string;
  author_name: string;
  category: string;
  observed_on: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface FinalEvaluationRow {
  id: string;
  trainee_id: string;
  record_version: number;
  ratings_json: string;
  strengths: string;
  improvements: string;
  summary: string;
  status: "DRAFT" | "CLOSED";
  updated_by: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface SignatureRow {
  id: string;
  trainee_id: string;
  record_version: number;
  scope_type: "OBSERVATION" | "SELF_SECTION" | "FINAL_EVALUATION";
  scope_id: string;
  payload_hash: string;
  signer_user_id: string | null;
  signer_name: string;
  signer_role: string;
  signature_object_key: string;
  signature_sha256: string;
  created_at: string;
}

export interface DocumentRow {
  id: string;
  trainee_id: string;
  record_version: number;
  object_key: string;
  sha256: string;
  byte_length: number;
  snapshot_json: string;
  created_by: string;
  created_at: string;
}
