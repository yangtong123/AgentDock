CREATE TABLE activity_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  task_id TEXT NOT NULL,
  workflow_run_id TEXT,
  step_run_id TEXT,
  actor TEXT,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_activity_events_task ON activity_events(task_id, id);

ALTER TABLE command_dedup ADD COLUMN response TEXT;
