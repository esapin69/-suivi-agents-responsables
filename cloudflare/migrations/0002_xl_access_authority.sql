CREATE TABLE users_identity_mirror (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  position TEXT NOT NULL DEFAULT '',
  last_verified_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO users_identity_mirror
  (id, first_name, last_name, display_name, position, last_verified_at, created_at, updated_at)
SELECT
  id, first_name, last_name, display_name, position, updated_at, created_at, updated_at
FROM users
WHERE legacy_access_version <> '';

DROP TABLE users;
ALTER TABLE users_identity_mirror RENAME TO users;

INSERT OR REPLACE INTO app_schema_migrations (version, name, applied_at)
VALUES (2, 'xl_access_authority', datetime('now'));
