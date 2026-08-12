PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  position TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('ADMIN', 'CHEF', 'AGENT')),
  permissions_json TEXT NOT NULL DEFAULT '{}',
  pin_lookup TEXT NOT NULL UNIQUE,
  pin_salt TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  pin_iterations INTEGER NOT NULL CHECK (pin_iterations >= 100000),
  session_version TEXT NOT NULL,
  legacy_access_version TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS trainees (
  id TEXT PRIMARY KEY,
  public_ref TEXT NOT NULL UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  school TEXT NOT NULL DEFAULT '',
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  tutor_user_id TEXT,
  tutor_name TEXT NOT NULL DEFAULT '',
  arrival_notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  record_version INTEGER NOT NULL DEFAULT 1 CHECK (record_version > 0),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS trainees_status_dates_idx
  ON trainees(status, start_date DESC, last_name, first_name);

CREATE TABLE IF NOT EXISTS trainee_self_sections (
  trainee_id TEXT NOT NULL,
  record_version INTEGER NOT NULL,
  expectations TEXT NOT NULL DEFAULT '',
  progress TEXT NOT NULL DEFAULT '',
  feedback TEXT NOT NULL DEFAULT '',
  comments TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (trainee_id, record_version),
  FOREIGN KEY (trainee_id) REFERENCES trainees(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  trainee_id TEXT NOT NULL,
  record_version INTEGER NOT NULL,
  author_user_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  category TEXT NOT NULL,
  observed_on TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (trainee_id) REFERENCES trainees(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS observations_trainee_version_idx
  ON observations(trainee_id, record_version, observed_on DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS final_evaluations (
  id TEXT PRIMARY KEY,
  trainee_id TEXT NOT NULL,
  record_version INTEGER NOT NULL,
  ratings_json TEXT NOT NULL DEFAULT '{}',
  strengths TEXT NOT NULL DEFAULT '',
  improvements TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'CLOSED')),
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  UNIQUE (trainee_id, record_version),
  FOREIGN KEY (trainee_id) REFERENCES trainees(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS access_links (
  id TEXT PRIMARY KEY,
  trainee_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  audience TEXT NOT NULL CHECK (audience IN ('TRAINEE')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  FOREIGN KEY (trainee_id) REFERENCES trainees(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS access_links_trainee_idx
  ON access_links(trainee_id, revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS signatures (
  id TEXT PRIMARY KEY,
  trainee_id TEXT NOT NULL,
  record_version INTEGER NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('OBSERVATION', 'SELF_SECTION', 'FINAL_EVALUATION')),
  scope_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  signer_user_id TEXT,
  signer_name TEXT NOT NULL,
  signer_role TEXT NOT NULL,
  signature_object_key TEXT NOT NULL UNIQUE,
  signature_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (scope_type, scope_id, signer_user_id, signer_role),
  FOREIGN KEY (trainee_id) REFERENCES trainees(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS signatures_trainee_version_idx
  ON signatures(trainee_id, record_version, created_at);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  trainee_id TEXT NOT NULL,
  record_version INTEGER NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length > 0),
  snapshot_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (trainee_id, record_version),
  FOREIGN KEY (trainee_id) REFERENCES trainees(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  trainee_id TEXT,
  record_version INTEGER,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('USER', 'TRAINEE', 'SYSTEM')),
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS audit_events_trainee_idx
  ON audit_events(trainee_id, record_version, created_at);

CREATE TRIGGER IF NOT EXISTS signatures_immutable_update
BEFORE UPDATE ON signatures BEGIN
  SELECT RAISE(ABORT, 'SIGNATURE_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS signatures_immutable_delete
BEFORE DELETE ON signatures BEGIN
  SELECT RAISE(ABORT, 'SIGNATURE_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS documents_immutable_update
BEFORE UPDATE ON documents BEGIN
  SELECT RAISE(ABORT, 'DOCUMENT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS documents_immutable_delete
BEFORE DELETE ON documents BEGIN
  SELECT RAISE(ABORT, 'DOCUMENT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS audit_immutable_update
BEFORE UPDATE ON audit_events BEGIN
  SELECT RAISE(ABORT, 'AUDIT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS audit_immutable_delete
BEFORE DELETE ON audit_events BEGIN
  SELECT RAISE(ABORT, 'AUDIT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS signed_observation_immutable_update
BEFORE UPDATE ON observations
WHEN EXISTS (
  SELECT 1 FROM signatures
  WHERE scope_type = 'OBSERVATION' AND scope_id = OLD.id
) BEGIN
  SELECT RAISE(ABORT, 'OBSERVATION_SIGNEE_IMMUABLE');
END;

CREATE TRIGGER IF NOT EXISTS signed_observation_immutable_delete
BEFORE DELETE ON observations
WHEN EXISTS (
  SELECT 1 FROM signatures
  WHERE scope_type = 'OBSERVATION' AND scope_id = OLD.id
) BEGIN
  SELECT RAISE(ABORT, 'OBSERVATION_SIGNEE_IMMUABLE');
END;

CREATE TRIGGER IF NOT EXISTS signed_self_section_immutable_update
BEFORE UPDATE ON trainee_self_sections
WHEN EXISTS (
  SELECT 1 FROM signatures
  WHERE scope_type = 'SELF_SECTION'
    AND scope_id = OLD.trainee_id || ':' || OLD.record_version
) BEGIN
  SELECT RAISE(ABORT, 'PARTIE_STAGIAIRE_SIGNEE_IMMUABLE');
END;

CREATE TRIGGER IF NOT EXISTS closed_final_evaluation_immutable_update
BEFORE UPDATE ON final_evaluations
WHEN OLD.status = 'CLOSED' BEGIN
  SELECT RAISE(ABORT, 'EVALUATION_CLOTUREE_IMMUABLE');
END;

CREATE TRIGGER IF NOT EXISTS closed_final_evaluation_immutable_delete
BEFORE DELETE ON final_evaluations
WHEN OLD.status = 'CLOSED' BEGIN
  SELECT RAISE(ABORT, 'EVALUATION_CLOTUREE_IMMUABLE');
END;

CREATE TRIGGER IF NOT EXISTS signed_final_evaluation_content_immutable
BEFORE UPDATE ON final_evaluations
WHEN EXISTS (
  SELECT 1 FROM signatures
  WHERE scope_type = 'FINAL_EVALUATION' AND scope_id = OLD.id
) AND (
  NEW.ratings_json <> OLD.ratings_json OR
  NEW.strengths <> OLD.strengths OR
  NEW.improvements <> OLD.improvements OR
  NEW.summary <> OLD.summary
) BEGIN
  SELECT RAISE(ABORT, 'EVALUATION_SIGNEE_IMMUABLE');
END;

INSERT OR IGNORE INTO app_schema_migrations (version, name, applied_at)
VALUES (1, 'initial', datetime('now'));
