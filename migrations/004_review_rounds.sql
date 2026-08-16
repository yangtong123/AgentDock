ALTER TABLE workflow_runs ADD COLUMN max_review_rounds INTEGER NOT NULL DEFAULT 3 CHECK (max_review_rounds BETWEEN 1 AND 10);
