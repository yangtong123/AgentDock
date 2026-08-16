import type { Database } from "../db/database.js";

export interface StepMetrics {
  stepType: string;
  count: number;
  totalDurationMs: number;
  failures: number;
}

export interface TaskMetrics {
  tasksSucceeded: number;
  tasksFailed: number;
  tasksCancelled: number;
  reviewRoundsTotal: number;
  verifyPasses: number;
  verifyFailures: number;
}

export interface UsageRecord {
  taskId: string;
  provider: string;
  role: string;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: string;
}

/**
 * Execution metrics, duration/usage tracking, and review/verification
 * statistics — derived from durable step/run/task state, plus explicit
 * usage records agents report (token counts when the provider emits them).
 */
export class MetricsService {
  constructor(private readonly db: Database, private readonly now = () => new Date().toISOString()) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      role TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      created_at TEXT NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS step_durations (
      step_run_id TEXT PRIMARY KEY,
      duration_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )`);
  }

  recordStepDuration(stepRunId: string, durationMs: number): void {
    this.db.prepare("INSERT INTO step_durations (step_run_id, duration_ms, created_at) VALUES (?,?,?) ON CONFLICT(step_run_id) DO UPDATE SET duration_ms = excluded.duration_ms")
      .run(stepRunId, durationMs, this.now());
  }

  recordUsage(entry: { taskId: string; provider: string; role: string; durationMs: number; inputTokens?: number | null; outputTokens?: number | null }): void {
    this.db.prepare("INSERT INTO agent_usage (task_id, provider, role, duration_ms, input_tokens, output_tokens, created_at) VALUES (?,?,?,?,?,?,?)")
      .run(entry.taskId, entry.provider, entry.role, entry.durationMs, entry.inputTokens ?? null, entry.outputTokens ?? null, this.now());
  }

  usageForTask(taskId: string): UsageRecord[] {
    return (this.db.prepare("SELECT * FROM agent_usage WHERE task_id = ? ORDER BY id").all(taskId) as Record<string, unknown>[]).map((row) => ({
      taskId: String(row.task_id), provider: String(row.provider), role: String(row.role), durationMs: Number(row.duration_ms),
      inputTokens: (row.input_tokens as number | null) ?? null, outputTokens: (row.output_tokens as number | null) ?? null, createdAt: String(row.created_at),
    }));
  }

  stepMetrics(): StepMetrics[] {
    const rows = this.db.prepare(`
      SELECT s.step_type AS stepType,
             COUNT(*) AS count,
             COALESCE(SUM(d.duration_ms), 0) AS totalDurationMs,
             SUM(CASE WHEN s.state = 'FAILED' THEN 1 ELSE 0 END) AS failures
      FROM step_runs s LEFT JOIN step_durations d ON d.step_run_id = s.id
      GROUP BY s.step_type ORDER BY s.step_type`).all() as Record<string, unknown>[];
    return rows.map((row) => ({ stepType: String(row.stepType), count: Number(row.count), totalDurationMs: Number(row.totalDurationMs), failures: Number(row.failures) }));
  }

  taskMetrics(): TaskMetrics {
    const tasks = this.db.prepare("SELECT state, COUNT(*) c FROM tasks GROUP BY state").all() as { state: string; c: number }[];
    const byState = new Map(tasks.map((row) => [row.state, Number(row.c)]));
    const reviews = Number((this.db.prepare("SELECT COUNT(*) c FROM step_runs WHERE step_type IN ('REVIEW') AND state = 'SUCCEEDED'").get() as { c: number }).c);
    const verifyPasses = Number((this.db.prepare("SELECT COUNT(*) c FROM step_runs WHERE step_type = 'VERIFY' AND state = 'SUCCEEDED'").get() as { c: number }).c);
    const verifyFailures = Number((this.db.prepare("SELECT COUNT(*) c FROM step_runs WHERE step_type = 'VERIFY' AND state = 'FAILED'").get() as { c: number }).c);
    return {
      tasksSucceeded: byState.get("SUCCEEDED") ?? 0,
      tasksFailed: byState.get("FAILED") ?? 0,
      tasksCancelled: (byState.get("CANCELLED") ?? 0) + (byState.get("CANCEL_REQUESTED") ?? 0),
      reviewRoundsTotal: reviews,
      verifyPasses,
      verifyFailures,
    };
  }
}

/** Budget control: caps per task and per project on agent step count and total duration. */
export class BudgetGuard {
  constructor(private readonly db: Database, private readonly metrics: MetricsService) {}

  withinBudget(taskId: string, limits: { maxStepsPerTask?: number; maxDurationMsPerTask?: number }): { ok: boolean; reason?: string } {
    const steps = Number((this.db.prepare(`SELECT COUNT(*) c FROM step_runs sr JOIN workflow_runs wr ON sr.workflow_run_id = wr.id JOIN task_revisions tr ON wr.task_revision_id = tr.id WHERE tr.task_id = ?`).get(taskId) as { c: number }).c);
    if (limits.maxStepsPerTask !== undefined && steps >= limits.maxStepsPerTask) return { ok: false, reason: `task reached maxStepsPerTask=${limits.maxStepsPerTask}` };
    if (limits.maxDurationMsPerTask !== undefined) {
      const duration = this.metrics.usageForTask(taskId).reduce((sum, record) => sum + record.durationMs, 0);
      if (duration >= limits.maxDurationMsPerTask) return { ok: false, reason: `task reached maxDurationMsPerTask=${limits.maxDurationMsPerTask}` };
    }
    return { ok: true };
  }
}
