CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  repo_path TEXT NOT NULL UNIQUE,
  base_branch TEXT NOT NULL,
  worktree_root TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'PAUSED', 'DISABLED')),
  max_concurrent_tasks INTEGER NOT NULL CHECK (max_concurrent_tasks > 0),
  default_workflow_preset TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('DRAFT', 'READY', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCEL_REQUESTED', 'CANCELLED')),
  current_revision INTEGER NOT NULL CHECK (current_revision > 0),
  branch TEXT,
  worktree_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, current_revision)
);

CREATE TABLE task_revisions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  request TEXT NOT NULL CHECK (length(trim(request)) > 0),
  created_at TEXT NOT NULL,
  UNIQUE (task_id, revision)
);

CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  task_revision_id TEXT NOT NULL REFERENCES task_revisions(id) ON DELETE RESTRICT,
  preset TEXT,
  state TEXT NOT NULL CHECK (state IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCEL_REQUESTED', 'CANCELLED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE step_runs (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_type TEXT NOT NULL CHECK (step_type IN ('PLAN', 'IMPLEMENT', 'VERIFY', 'REVIEW', 'FIX', 'FINAL_REVIEW', 'HUMAN_APPROVAL')),
  state TEXT NOT NULL CHECK (state IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCEL_REQUESTED', 'CANCELLED')),
  provider TEXT,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workflow_run_id, sequence)
);

CREATE TABLE agent_threads (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  role TEXT NOT NULL,
  external_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  workflow_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  step_run_id TEXT REFERENCES step_runs(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  storage_type TEXT NOT NULL CHECK (storage_type IN ('INLINE', 'FILE')),
  content TEXT,
  path TEXT,
  created_at TEXT NOT NULL,
  CHECK ((storage_type = 'INLINE' AND content IS NOT NULL AND path IS NULL) OR
         (storage_type = 'FILE' AND path IS NOT NULL AND content IS NULL))
);

CREATE INDEX idx_tasks_project_id ON tasks(project_id);
CREATE INDEX idx_task_revisions_task_id ON task_revisions(task_id);
CREATE INDEX idx_workflow_runs_revision_id ON workflow_runs(task_revision_id);
CREATE INDEX idx_step_runs_workflow_id ON step_runs(workflow_run_id);
CREATE INDEX idx_agent_threads_task_id ON agent_threads(task_id);
CREATE INDEX idx_artifacts_task_id ON artifacts(task_id);
