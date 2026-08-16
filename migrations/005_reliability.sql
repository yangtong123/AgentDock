CREATE TABLE command_dedup (
  command_key TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE outbox_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
  workflow_run_id TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  processed_at TEXT,
  processed_by TEXT
);

CREATE INDEX idx_outbox_unprocessed ON outbox_events(id) WHERE processed_at IS NULL;

CREATE TABLE worker_leases (
  lease_key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  task_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE task_queue (
  task_id TEXT PRIMARY KEY,
  priority INTEGER NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 9),
  queued_at TEXT NOT NULL,
  scheduled_at TEXT NOT NULL
);

CREATE INDEX idx_task_queue_due ON task_queue(scheduled_at, priority DESC);
