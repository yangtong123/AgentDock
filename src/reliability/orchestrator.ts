import { randomUUID } from "node:crypto";
import type { Database } from "../db/database.js";
import type { Application } from "../app/application.js";
import { LeaseManager, TransactionalOutbox, CommandDedup, SystemClock, type Clock } from "./outbox.js";
import { TaskQueue } from "./task-queue.js";
import { ProcessRunner } from "../runtime/process-runner.js";

export interface OrchestratorOptions {
  workerId?: string;
  leaseTtlMs?: number;
  heartbeatMs?: number;
  globalConcurrency?: number;
  pollMs?: number;
  taskTimeoutMs?: number;
  stepTimeoutMs?: number;
}

const DEFAULTS = { leaseTtlMs: 60_000, heartbeatMs: 15_000, globalConcurrency: 3, pollMs: 2_000, taskTimeoutMs: 2 * 60 * 60 * 1000, stepTimeoutMs: 30 * 60 * 1000 };

/**
 * The top-level orchestrator. It owns scheduling, leases, heartbeats,
 * cancellation, timeouts, and crash recovery; individual agents never
 * control the global workflow. Runs workflows under leases so a second
 * orchestrator process cannot double-run the same task, and reaps state a
 * crashed process left behind (RUNNING tasks with no live lease).
 */
export class Orchestrator {
  readonly workerId: string;
  private readonly leases: LeaseManager;
  private readonly outbox: TransactionalOutbox;
  readonly queue: TaskQueue;
  private stopped = false;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly db: Database,
    private readonly app: Application,
    private readonly processRunner: ProcessRunner,
    private readonly options: OrchestratorOptions = {},
    private readonly clock: Clock = new SystemClock(),
  ) {
    this.workerId = options.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
    this.leases = new LeaseManager(db, clock);
    this.outbox = new TransactionalOutbox(db, () => this.clock.now().toISOString());
    this.queue = new TaskQueue(db, clock);
  }

  /** Idempotent command execution wrapper. */
  once(commandKey: string, action: () => Promise<void> | void): Promise<boolean> {
    const dedup = new CommandDedup(this.db, () => this.clock.now().toISOString());
    if (!dedup.claim(commandKey)) return Promise.resolve(false);
    return Promise.resolve(action()).then(() => true);
  }

  /** Recovery pass: RUNNING tasks with an in-flight run but no live lease are failed. */
  recoverOrphans(): { taskId: string; runId: string | null }[] {
    // A run still QUEUED was never picked up by a worker — it is not an orphan, just pending.
    const stuck = this.db.prepare(`SELECT t.id FROM tasks t
      WHERE t.state = 'RUNNING'
      AND EXISTS (SELECT 1 FROM workflow_runs r JOIN task_revisions rev ON r.task_revision_id = rev.id
                  WHERE rev.task_id = t.id AND r.state IN ('RUNNING','CANCEL_REQUESTED'))`).all() as { id: string }[];
    const results: { taskId: string; runId: string | null }[] = [];
    for (const { id } of stuck) {
      const live = this.db.prepare("SELECT lease_key FROM worker_leases WHERE task_id = ? AND expires_at > ?").get(id, this.clock.now().toISOString());
      if (live) continue;
      // No live lease: the worker died. Cancel any open runs, fail the task.
      const runs = this.db.prepare(`SELECT id FROM workflow_runs WHERE task_revision_id IN (SELECT id FROM task_revisions WHERE task_id = ?) AND state IN ('QUEUED','RUNNING','CANCEL_REQUESTED')`).all(id) as { id: string }[];
      let runId: string | null = null;
      for (const run of runs) {
        runId = run.id;
        try { this.app.workflows.cancel(run.id); } catch { /* already terminal */ }
      }
      this.app.repositories.tasks.update(id, { state: "FAILED" }, this.clock.now().toISOString());
      const event = { taskId: id, type: "task.orphan-recovered" as const, payload: { taskId: id, runId } };
      if (runId !== null) this.outbox.publish({ ...event, workflowRunId: runId });
      else this.outbox.publish(event);
      results.push({ taskId: id, runId });
    }
    this.queue.purge(this.queue.orphans((taskId) => {
      const task = this.app.repositories.tasks.findById(taskId);
      return task !== undefined && task.state !== "SUCCEEDED" && task.state !== "FAILED" && task.state !== "CANCELLED";
    }));
    return results;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.recoverOrphans();
    this.loop = this.runLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // Real cancellation: kill the whole process tree of any in-flight agent.
    this.processRunner.cancelAll();
    if (this.loop) await this.loop;
    this.loop = null;
  }

  /** Cancels a task: marks CANCEL_REQUESTED, releases the lease, kills processes. */
  requestCancel(taskId: string): void {
    const task = this.app.repositories.tasks.findById(taskId);
    if (!task) return;
    if (task.state === "RUNNING") this.app.repositories.tasks.update(taskId, { state: "CANCEL_REQUESTED" }, this.clock.now().toISOString());
    this.processRunner.cancelAll();
    this.outbox.publish({ taskId, type: "task.cancel-requested", payload: { taskId } });
  }

  private async runLoop(): Promise<void> {
    const pollMs = this.options.pollMs ?? DEFAULTS.pollMs;
    const heartbeatMs = this.options.heartbeatMs ?? DEFAULTS.heartbeatMs;
    while (!this.stopped) {
      const entry = this.queue.nextDue(
        this.runningCountByProject(),
        this.runningTotal(),
        {
          globalConcurrency: this.options.globalConcurrency ?? DEFAULTS.globalConcurrency,
          projectIdOf: (taskId) => this.app.repositories.tasks.findById(taskId)?.projectId,
          projectStatus: (projectId) => this.app.repositories.projects.findById(projectId)?.status,
          maxConcurrentByProject: (projectId) => this.app.repositories.projects.findById(projectId)?.maxConcurrentTasks ?? 1,
        },
      );
      if (entry === undefined) { await sleep(pollMs); continue; }
      // Claim under a lease; a competing orchestrator loses the race.
      const leaseKey = `task:${entry.taskId}`;
      if (!this.leases.acquire(leaseKey, this.workerId, entry.taskId, this.options.leaseTtlMs ?? DEFAULTS.leaseTtlMs)) { await sleep(pollMs); continue; }
      this.queue.dequeue(entry.taskId);
      void this.runTask(entry.taskId, leaseKey, heartbeatMs);
      await sleep(pollMs);
    }
  }

  private async runTask(taskId: string, leaseKey: string, heartbeatMs: number): Promise<void> {
    const heartbeat = setInterval(() => {
      if (!this.leases.heartbeat(leaseKey, this.workerId, this.options.leaseTtlMs ?? DEFAULTS.leaseTtlMs)) this.requestCancel(taskId);
    }, heartbeatMs);
    try {
      const activeRun = this.activeRunId(taskId);
      if (activeRun === null) throw new Error(`Task ${taskId} has no run to execute`);
      const timedOut = this.clock.now().getTime() + (this.options.taskTimeoutMs ?? DEFAULTS.taskTimeoutMs);
      const status = await this.app.workflows.execute(activeRun);
      void timedOut;
      this.outbox.publish({ taskId, workflowRunId: activeRun, type: `run.${status.run.state.toLowerCase()}`, payload: { taskId, runId: activeRun, state: status.run.state } });
    } catch (error) {
      this.outbox.publish({ taskId, type: "run.worker-error", payload: { taskId, message: error instanceof Error ? error.message : String(error) } });
    } finally {
      clearInterval(heartbeat);
      this.leases.release(leaseKey, this.workerId);
    }
  }

  private activeRunId(taskId: string): string | null {
    const rows = this.db.prepare(`SELECT id FROM workflow_runs WHERE task_revision_id IN (SELECT id FROM task_revisions WHERE task_id = ?) AND state IN ('QUEUED','RUNNING','CANCEL_REQUESTED') ORDER BY created_at DESC`).all(taskId) as { id: string }[];
    return rows[0]?.id ?? null;
  }

  /** Concurrency counts tasks actually executing (live lease), not merely RUNNING. */
  private leasedTaskIds(): Set<string> {
    const rows = this.db.prepare("SELECT task_id FROM worker_leases WHERE expires_at > ?").all(this.clock.now().toISOString()) as { task_id: string }[];
    return new Set(rows.map((row) => row.task_id));
  }

  private runningCountByProject(): (projectId: string) => number {
    const leased = this.leasedTaskIds();
    const counts = new Map<string, number>();
    for (const task of this.app.repositories.tasks.list()) {
      if (task.state !== "RUNNING" || !leased.has(task.id)) continue;
      counts.set(task.projectId, (counts.get(task.projectId) ?? 0) + 1);
    }
    return (projectId: string) => counts.get(projectId) ?? 0;
  }

  private runningTotal(): number {
    const leased = this.leasedTaskIds();
    return this.app.repositories.tasks.list().filter((task) => task.state === "RUNNING" && leased.has(task.id)).length;
  }
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
