-- Conversation origin and task subscription tracking move out of
-- im_conversations: its PK (conversation_id, adapter) with fixed adapter
-- markers ('origin'/'subscription') collapsed two platforms sharing one
-- conversationId onto a single row. These tables key on the REAL adapter
-- name, so telegram and feishu rows coexist.

CREATE TABLE im_conversation_origins (
  conversation_id TEXT NOT NULL,
  adapter TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, adapter)
);

CREATE TABLE im_task_subscriptions (
  conversation_id TEXT NOT NULL,
  adapter TEXT NOT NULL,
  task_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, adapter)
);

-- Migrate legacy rows (no-op on fresh databases): the real adapter name
-- lived in im_conversations.project_id.
INSERT INTO im_conversation_origins (conversation_id, adapter, updated_at)
  SELECT conversation_id, project_id, updated_at FROM im_conversations
  WHERE adapter = 'origin' AND project_id IS NOT NULL
  ON CONFLICT DO NOTHING;

INSERT INTO im_task_subscriptions (conversation_id, adapter, task_id, updated_at)
  SELECT conversation_id, COALESCE(project_id, ''), focused_task_id, updated_at FROM im_conversations
  WHERE adapter IN ('subscription', 'dispatcher') AND focused_task_id IS NOT NULL
  ON CONFLICT DO NOTHING;

DELETE FROM im_conversations WHERE adapter IN ('origin', 'subscription', 'dispatcher');
