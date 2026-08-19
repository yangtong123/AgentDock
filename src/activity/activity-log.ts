import type { Database } from "../db/database.js";

export const ACTIVITY_EVENTS = {
  taskCreated: "task.created",
  taskRevised: "task.revised",
  taskPrepared: "task.prepared",
  taskCancelRequested: "task.cancel-requested",
  taskSucceeded: "task.succeeded",
  taskFailed: "task.failed",
  taskCancelled: "task.cancelled",
  runQueued: "run.queued",
  runRunning: "run.running",
  runPaused: "run.paused",
  runSucceeded: "run.succeeded",
  runFailed: "run.failed",
  runCancelled: "run.cancelled",
  stepStarted: "step.started",
  stepSucceeded: "step.succeeded",
  stepFailed: "step.failed",
  stepCancelled: "step.cancelled",
  approvalRequested: "approval.requested",
  approvalDecided: "approval.decided",
  reviewCompleted: "review.completed",
  verifyCompleted: "verify.completed",
  artifactCreated: "artifact.created",
} as const;
export type ActivityEventType = (typeof ACTIVITY_EVENTS)[keyof typeof ACTIVITY_EVENTS];

export interface ActivityEvent {
  id: number;
  type: string;
  taskId: string;
  workflowRunId: string | null;
  stepRunId: string | null;
  actor: string | null;
  payload: string;
  createdAt: string;
}

/** Structural sink so domain code records activity without importing the concrete log. */
export interface ActivitySink {
  record(event: { type: string; taskId: string; runId?: string; stepRunId?: string; actor?: string; payload?: unknown }): void;
}

/**
 * Durable activity stream: every domain-visible transition lands here as an
 * append-only row with a monotonic id, so SSE consumers can replay from a
 * cursor. The poke listeners are an in-process latency hint (used by SSE to
 * re-query immediately); polling is the source of truth.
 */
export class ActivityLog {
  private readonly listeners = new Set<() => void>();

  constructor(private readonly db: Database, private readonly now = () => new Date().toISOString()) {}

  record(event: { type: string; taskId: string; runId?: string; stepRunId?: string; actor?: string; payload?: unknown }): void {
    this.db.prepare("INSERT INTO activity_events (type, task_id, workflow_run_id, step_run_id, actor, payload, created_at) VALUES (?,?,?,?,?,?,?)")
      .run(event.type, event.taskId, event.runId ?? null, event.stepRunId ?? null, event.actor ?? null, JSON.stringify(event.payload ?? {}), this.now());
    for (const listener of this.listeners) listener();
  }

  /** Latency hint for in-process consumers (SSE). Returns an unsubscribe. */
  onPoke(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Events after cursor `afterId`, oldest first. */
  listSince(afterId: number, limit: number): ActivityEvent[] {
    const rows = this.db.prepare("SELECT * FROM activity_events WHERE id > ? ORDER BY id LIMIT ?").all(afterId, limit) as Record<string, unknown>[];
    return rows.map((row) => toEvent(row));
  }

  /** Latest events for one task (newest last), for the workbench timeline. */
  listForTask(taskId: string, limit: number): ActivityEvent[] {
    const rows = this.db.prepare("SELECT * FROM activity_events WHERE task_id = ? ORDER BY id DESC LIMIT ?").all(taskId, limit) as Record<string, unknown>[];
    return rows.reverse().map((row) => toEvent(row));
  }
}

function toEvent(row: Record<string, unknown>): ActivityEvent {
  return {
    id: Number(row.id),
    type: String(row.type),
    taskId: String(row.task_id),
    workflowRunId: (row.workflow_run_id as string | null) ?? null,
    stepRunId: (row.step_run_id as string | null) ?? null,
    actor: (row.actor as string | null) ?? null,
    payload: String(row.payload),
    createdAt: String(row.created_at),
  };
}
