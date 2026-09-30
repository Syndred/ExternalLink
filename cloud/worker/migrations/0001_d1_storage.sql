-- Dedicated ExternalLink database; large immutable payloads live in R2.
CREATE TABLE IF NOT EXISTS documents (
  workspace TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL,
  object_key TEXT NOT NULL, checksum TEXT NOT NULL, bytes INTEGER NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY(workspace,key)
);
CREATE TABLE IF NOT EXISTS document_history (
  workspace TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL,
  object_key TEXT NOT NULL, checksum TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(workspace,key,revision)
);
CREATE TABLE IF NOT EXISTS journal_tasks (
  workspace TEXT NOT NULL, id TEXT NOT NULL, profile_id TEXT NOT NULL,
  destination TEXT NOT NULL, summary TEXT NOT NULL, object_key TEXT NOT NULL,
  checksum TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(workspace,id)
);
CREATE INDEX IF NOT EXISTS journal_profile ON journal_tasks(workspace,profile_id,id);
CREATE TABLE IF NOT EXISTS recovery_objects (
  workspace TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL,
  object_key TEXT NOT NULL, checksum TEXT NOT NULL, bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL, PRIMARY KEY(workspace,id)
);
