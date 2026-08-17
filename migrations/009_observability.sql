ALTER TABLE workflow_runs ADD COLUMN step_timeout_ms INTEGER NOT NULL DEFAULT 1800000 CHECK (step_timeout_ms > 0);

CREATE TABLE IF NOT EXISTS agent_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  role TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS step_durations (
  step_run_id TEXT PRIMARY KEY,
  duration_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  task_id TEXT,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_usage_task ON agent_usage(task_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_task ON audit_log(task_id);
