CREATE TABLE IF NOT EXISTS im_conversations (
  conversation_id TEXT NOT NULL,
  adapter TEXT NOT NULL,
  project_id TEXT,
  focused_task_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, adapter)
);
