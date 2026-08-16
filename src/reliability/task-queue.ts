import type { Database } from "../db/database.js";
import { SystemClock, type Clock } from "./outbox.js";

export interface QueueEntry { taskId: string; priority: number; queuedAt: string; scheduledAt: string }

/**
 * Durable task queue: priority (9 first), scheduled start times, and
 * per-project + global concurrency gating. PAUSED/DISABLED projects stop
 * dequeuing entirely.
 */
export class TaskQueue {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock = new SystemClock(),
  ) { void db; }

  enqueue(taskId: string, options: { priority?: number; scheduledAt?: Date } = {}): QueueEntry {
    const priority = options.priority ?? 5;
    if (!Number.isInteger(priority) || priority < 1 || priority > 9) throw new Error("priority must be an integer 1-9");
    const now = this.clock.now().toISOString();
    const scheduledAt = (options.scheduledAt ?? this.clock.now()).toISOString();
    this.db.prepare(`INSERT INTO task_queue (task_id, priority, queued_at, scheduled_at) VALUES (?,?,?,?)
      ON CONFLICT (task_id) DO UPDATE SET priority = excluded.priority, scheduled_at = excluded.scheduled_at`).run(taskId, priority, now, scheduledAt);
    return { taskId, priority, queuedAt: now, scheduledAt };
  }

  dequeue(taskId: string): QueueEntry | undefined {
    const row = this.db.prepare("SELECT * FROM task_queue WHERE task_id = ?").get(taskId) as Record<string, unknown> | undefined;
    if (row) this.db.prepare("DELETE FROM task_queue WHERE task_id = ?").run(taskId);
    return row === undefined ? undefined : { taskId: String(row.task_id), priority: Number(row.priority), queuedAt: String(row.queued_at), scheduledAt: String(row.scheduled_at) };
  }

  /** Next due task under the concurrency and project-status gates. */
  nextDue(runningCountByProject: (projectId: string) => number, totalRunning: number, options: { globalConcurrency: number; projectIdOf: (taskId: string) => string | undefined; projectStatus: (projectId: string) => string | undefined; maxConcurrentByProject: (projectId: string) => number }): QueueEntry | undefined {
    const now = this.clock.now().toISOString();
    const rows = this.db.prepare("SELECT * FROM task_queue WHERE scheduled_at <= ? ORDER BY priority DESC, queued_at, task_id").all(now) as Record<string, unknown>[];
    for (const row of rows) {
      if (totalRunning >= options.globalConcurrency) return undefined;
      const projectId = options.projectIdOf(String(row.task_id));
      if (projectId === undefined) continue;
      if (options.projectStatus(projectId) !== "ACTIVE") continue;
      if (runningCountByProject(projectId) >= options.maxConcurrentByProject(projectId)) continue;
      return { taskId: String(row.task_id), priority: Number(row.priority), queuedAt: String(row.queued_at), scheduledAt: String(row.scheduled_at) };
    }
    return undefined;
  }

  size(): number {
    return Number((this.db.prepare("SELECT COUNT(*) c FROM task_queue").get() as { c: number }).c);
  }

  /** Tasks whose queue entry exists but whose task row is gone or finished. */
  orphans(isLiveTask: (taskId: string) => boolean): string[] {
    const rows = this.db.prepare("SELECT task_id FROM task_queue").all() as { task_id: string }[];
    return rows.filter((row) => !isLiveTask(row.task_id)).map((row) => row.task_id);
  }

  purge(taskIds: string[]): number {
    let removed = 0;
    for (const taskId of taskIds) removed += Number(this.db.prepare("DELETE FROM task_queue WHERE task_id = ?").run(taskId).changes);
    return removed;
  }
}
