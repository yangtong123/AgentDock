import type { Database } from "../db/database.js";
import { TransactionalOutbox, type OutboxEvent } from "./outbox.js";

/** Formats an outbox event as a human-facing IM notification. */
function describeEvent(event: OutboxEvent): string | null {
  const payload = JSON.parse(event.payload) as Record<string, unknown>;
  switch (event.type) {
    case "run.succeeded": return `Task finished: SUCCEEDED (${String(payload.runId ?? "")})`;
    case "run.failed": return `Task finished: FAILED (${String(payload.runId ?? "")})`;
    case "run.cancelled": return `Task cancelled (${String(payload.runId ?? "")})`;
    case "task.timeout": return `Task timed out and was cancelled.`;
    case "fix.started": return `Fix workflow started for CI/review failures (${String(payload.runId ?? "")}).`;
    case "task.orphan-recovered": return `Task recovered after a worker crash; check its state.`;
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

  private static readonly SUB_ADAPTER = "subscription";

  /**
   * Records which conversation to notify about a task. Subscriptions are
   * scoped to (conversation, adapter): two platforms using the same
   * conversation id never receive each other's notifications.
   */
  subscribe(conversationId: string, taskId: string, adapter: string | null): void {
    this.db.prepare(`INSERT INTO im_conversations (conversation_id, adapter, project_id, focused_task_id, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (conversation_id, adapter) DO UPDATE SET focused_task_id = excluded.focused_task_id, updated_at = excluded.updated_at`)
      .run(conversationId, OutboxDispatcher.SUB_ADAPTER, adapter, taskId, this.now());
  }

  private subscribersFor(taskId: string | null): { conversationId: string; adapter: string | null }[] {
    if (taskId === null) return [];
    return (this.db.prepare("SELECT conversation_id, project_id FROM im_conversations WHERE adapter = ? AND focused_task_id = ?").all(OutboxDispatcher.SUB_ADAPTER, taskId) as { conversation_id: string; project_id: string | null }[])
      .map((row) => ({ conversationId: row.conversation_id, adapter: row.project_id }));
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
        const text = describeEvent(event);
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
