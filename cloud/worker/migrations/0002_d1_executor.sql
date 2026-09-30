CREATE TABLE IF NOT EXISTS executor_devices(workspace TEXT NOT NULL,id TEXT NOT NULL,token_hash TEXT NOT NULL,name TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(workspace,id),UNIQUE(workspace,token_hash));
CREATE TABLE IF NOT EXISTS executor_enrollments(token_hash TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS executor_runs(workspace TEXT NOT NULL,id TEXT NOT NULL,device_id TEXT NOT NULL,summary TEXT NOT NULL,object_key TEXT NOT NULL,checksum TEXT NOT NULL,PRIMARY KEY(workspace,id));
CREATE TABLE IF NOT EXISTS executor_controls(workspace TEXT NOT NULL,id TEXT NOT NULL,run_id TEXT NOT NULL,device_id TEXT NOT NULL,identity TEXT NOT NULL,host_identity TEXT NOT NULL,version INTEGER NOT NULL,controller_id TEXT,lease_until INTEGER NOT NULL DEFAULT 0,review_status TEXT NOT NULL DEFAULT 'pending_review',PRIMARY KEY(workspace,id),UNIQUE(workspace,identity),UNIQUE(workspace,host_identity));
CREATE INDEX IF NOT EXISTS executor_device_tasks ON executor_controls(workspace,device_id,run_id,id);
CREATE TABLE IF NOT EXISTS executor_events(workspace TEXT NOT NULL,id TEXT NOT NULL,device_id TEXT NOT NULL,task_id TEXT NOT NULL,checksum TEXT NOT NULL,object_key TEXT NOT NULL,object_checksum TEXT NOT NULL,item_index INTEGER,created_at TEXT NOT NULL,PRIMARY KEY(workspace,id));
CREATE INDEX IF NOT EXISTS executor_events_task ON executor_events(workspace,task_id,id);
CREATE INDEX IF NOT EXISTS executor_events_device ON executor_events(workspace,device_id,id);
ALTER TABLE journal_tasks ADD COLUMN item_index INTEGER;
