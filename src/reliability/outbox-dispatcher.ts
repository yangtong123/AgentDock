import type { Database } from "../db/database.js";
import { TransactionalOutbox, type OutboxEvent } from "./outbox.js";

/** Formats an outbox event as a human-facing IM notification. Ids are included
 *  so the user can act from any surface (/approve RUN_ID etc.). */
function describeEvent(event: OutboxEvent, runStateOf: (taskId: string) => { id: string; state: string } | undefined): string | null {
  const payload = JSON.parse(event.payload) as Record<string, unknown>;
  const taskId = String(payload.taskId ?? event.taskId ?? "");
  const runId = String(payload.runId ?? event.workflowRunId ?? "");
  const ids = `task ${taskId.slice(0, 8)} · run ${runId.slice(0, 8)}`;
  switch (event.type) {
    case "run.succeeded": return `Task ${taskId.slice(0, 8)} finished: SUCCEEDED (run ${runId.slice(0, 8)})`;
    case "run.failed": return `Task ${taskId.slice(0, 8)} finished: FAILED (run ${runId.slice(0, 8)})`;
    case "run.cancelled": return `Task ${taskId.slice(0, 8)} cancelled (run ${runId.slice(0, 8)})`;
    case "task.timeout": return `Task ${taskId.slice(0, 8)} timed out and was cancelled.`;
    case "approval.requested": return `Approval needed: ${ids}\n/approve ${runId} or /reject ${runId}`;
    case "fix.started": return `Fix workflow started for CI/review failures (task ${taskId.slice(0, 8)}, run ${runId.slice(0, 8)}).`;
    case "task.orphan-recovered": return `Task ${taskId.slice(0, 8)} recovered after a worker crash; check its state.`;
    case "run.worker-error": {
      // A cancel during VERIFY unwinds here (ProcessCancelledError), not via a
      // run.cancelled event — render the resolved terminal state, not the error.
      const run = runStateOf(taskId);
      if (run?.state === "CANCELLED") return `Task ${taskId.slice(0, 8)} cancelled (run ${run.id.slice(0, 8)})`;
      return `Task ${taskId.slice(0, 8)} failed: ${String(payload.message ?? "worker error")}`;
    }
    default: return null; // internal events stay internal
  }
}

/**
 * Delivers outbox events to interested IM conversations. Subscription is the
 * conversation's focused task (tracked in im_conversations): whoever ran,
 * approved, or last interacted with a task hears about its terminal events.
 * Delivery is at-least-once; IM adapters tolerate duplicate sends.
 */
export class OutboxDispatcher {
  private stopped = false;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly db: Database,
    private readonly outbox: TransactionalOutbox,
    private readonly send: (conversationId: string, text: string, adapter: string | null) => Promise<void>,
    private readonly workerId: string,
    private readonly pollMs = 2_000,
    private readonly now = () => new Date().toISOString(),
  ) {}

  /**
   * Records which conversation to notify about a task. Rows key on the real
   * adapter name: telegram and feishu subscriptions for the same task coexist
   * even when both platforms use the same conversation id.
   */
  subscribe(conversationId: string, taskId: string, adapter: string | null): void {
    this.db.prepare(`INSERT INTO im_task_subscriptions (conversation_id, adapter, task_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (conversation_id, adapter) DO UPDATE SET task_id = excluded.task_id, updated_at = excluded.updated_at`)
      .run(conversationId, adapter ?? "", taskId, this.now());
  }

  private subscribersFor(taskId: string | null): { conversationId: string; adapter: string | null }[] {
    if (taskId === null) return [];
    return (this.db.prepare("SELECT conversation_id, adapter FROM im_task_subscriptions WHERE task_id = ?").all(taskId) as { conversation_id: string; adapter: string }[])
      .map((row) => ({ conversationId: row.conversation_id, adapter: row.adapter === "" ? null : row.adapter }));
  }

  /** Latest run for a task (insertion order breaks created_at ties). */
  private latestRunState(taskId: string): { id: string; state: string } | undefined {
    return this.db.prepare("SELECT r.id AS id, r.state AS state FROM workflow_runs r JOIN task_revisions tr ON r.task_revision_id = tr.id WHERE tr.task_id = ? ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1").get(taskId) as { id: string; state: string } | undefined;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.loop = this.runLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.loop) await this.loop;
    this.loop = null;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      const delivered = await this.drainOnce();
      if (delivered === 0) await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }

  /** Processes one batch; returns how many events were delivered or skipped. */
  async drainOnce(): Promise<number> {
    const events = this.outbox.claimBatch(this.workerId, 20);
    for (const event of events) {
      try {
        const text = describeEvent(event, (taskId) => this.latestRunState(taskId));
        if (text !== null) {
          for (const subscriber of this.subscribersFor(event.taskId)) {
            await this.send(subscriber.conversationId, text, subscriber.adapter);
          }
        }
        this.outbox.markProcessed(event.id, this.workerId);
      } catch {
        // Delivery failed: release the claim so the next poll retries.
        this.outbox.releaseClaim(event.id);
      }
    }
    return events.length;
  }
}
