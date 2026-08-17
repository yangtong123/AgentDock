import { randomUUID } from "node:crypto";
import type { Database } from "../db/database.js";
import { withImmediateTransaction } from "../db/database.js";
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
  /** In-flight runTask promises; stop() awaits them after cancelling. */
  private readonly activeTasks = new Set<Promise<void>>();

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

  /** Idempotent command execution wrapper. The dedup key is only consumed on success. */
  async once(commandKey: string, action: () => Promise<void> | void): Promise<boolean> {
    const dedup = new CommandDedup(this.db, () => this.clock.now().toISOString());
    if (!dedup.claim(commandKey)) return false;
    try {
      await action();
      return true;
    } catch (error) {
      // Failed commands stay retryable: release the key before propagating.
      this.db.prepare("DELETE FROM command_dedup WHERE command_key = ?").run(commandKey);
      throw error;
    }
  }

  /**
   * Recovery pass: RUNNING tasks with an in-flight run but no live lease are
   * failed. Recovery contract:
   * - A task present in task_queue is pending pickup (fresh enqueue, or a run
   *   re-enqueued after an approval) — never an orphan. The queue entry is
   *   consumed at claim time, so a queued entry always means "not yet started".
   * - A run paused at a HUMAN_APPROVAL gate is legitimately idle — never an orphan.
   * - Everything else (a worker that died mid-step, an inline execution whose
   *   process crashed, a run left QUEUED without a queue entry) is cancelled
   *   and settled: RUNNING tasks become FAILED, CANCEL_REQUESTED tasks become
   *   CANCELLED. There is no mid-step resume.
   *
   * The candidate list below is only an optimization: every per-task decision
   * re-evaluates the full predicate (task state, queue, open runs, approval
   * gate, live lease) inside the write transaction — see recoverIfOrphaned.
   */
  recoverOrphans(): { taskId: string; runId: string | null }[] {
    const candidates = this.db.prepare(`SELECT t.id FROM tasks t
      WHERE t.state IN ('RUNNING','CANCEL_REQUESTED')
      AND NOT EXISTS (SELECT 1 FROM task_queue q WHERE q.task_id = t.id)
      AND EXISTS (SELECT 1 FROM workflow_runs r JOIN task_revisions rev ON r.task_revision_id = rev.id
                  WHERE rev.task_id = t.id AND r.state IN ('QUEUED','RUNNING','CANCEL_REQUESTED')
                    AND NOT EXISTS (SELECT 1 FROM step_runs g WHERE g.workflow_run_id = r.id
                                    AND g.step_type = 'HUMAN_APPROVAL' AND g.state = 'QUEUED'
                                    AND NOT EXISTS (SELECT 1 FROM step_runs p WHERE p.workflow_run_id = r.id
                                                    AND p.sequence < g.sequence AND p.state NOT IN ('SUCCEEDED'))))`).all() as { id: string }[];
    const results: { taskId: string; runId: string | null }[] = [];
    for (const { id } of candidates) {
      const recovered = this.recoverIfOrphaned(id);
      if (recovered !== null) results.push(recovered);
    }
    this.queue.purge(this.queue.orphans((taskId) => {
      const task = this.app.repositories.tasks.findById(taskId);
      return task !== undefined && task.state !== "SUCCEEDED" && task.state !== "FAILED" && task.state !== "CANCELLED";
    }));
    return results;
  }

  /**
   * Atomically classifies and recovers one task. The complete orphan
   * predicate — task RUNNING, no queue entry, an open run not paused at an
   * approval gate, no live lease — is re-evaluated inside BEGIN IMMEDIATE, so
   * a run that finished (or a lease that was taken over) after the candidate
   * scan can never have its task overwritten to FAILED. Returns null when the
   * task is not an orphan.
   */
  recoverIfOrphaned(taskId: string): { taskId: string; runId: string | null } | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const task = this.app.repositories.tasks.findById(taskId);
      const openRuns = this.db.prepare(`SELECT r.id FROM workflow_runs r
        JOIN task_revisions rev ON r.task_revision_id = rev.id
        JOIN tasks t ON t.id = rev.task_id
        WHERE t.id = ? AND t.state IN ('RUNNING','CANCEL_REQUESTED')
          AND NOT EXISTS (SELECT 1 FROM task_queue q WHERE q.task_id = t.id)
          AND r.state IN ('QUEUED','RUNNING','CANCEL_REQUESTED')
          AND NOT EXISTS (SELECT 1 FROM step_runs g WHERE g.workflow_run_id = r.id
                          AND g.step_type = 'HUMAN_APPROVAL' AND g.state = 'QUEUED'
                          AND NOT EXISTS (SELECT 1 FROM step_runs p WHERE p.workflow_run_id = r.id
                                          AND p.sequence < g.sequence AND p.state NOT IN ('SUCCEEDED')))`).all(taskId) as { id: string }[];
      const live = this.db.prepare("SELECT lease_key FROM worker_leases WHERE task_id = ? AND expires_at > ?").get(taskId, this.clock.now().toISOString());
      if (task === undefined || openRuns.length === 0 || live) { this.db.exec("COMMIT"); return null; }
      // No live lease: the worker died. Cancel the open runs and settle the
      // task — a task the user asked to cancel settles CANCELLED, a crashed
      // one FAILED.
      let runId: string | null = null;
      for (const run of openRuns) {
        runId = run.id;
        try { this.app.workflows.cancel(run.id); } catch { /* already terminal */ }
      }
      const terminal = task.state === "CANCEL_REQUESTED" ? "CANCELLED" : "FAILED";
      this.app.repositories.tasks.update(taskId, { state: terminal }, this.clock.now().toISOString());
      const event = { taskId, type: "task.orphan-recovered" as const, payload: { taskId, runId } };
      if (runId !== null) this.outbox.publish({ ...event, workflowRunId: runId });
      else this.outbox.publish(event);
      this.db.exec("COMMIT");
      return { taskId, runId };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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
    // Wait for in-flight tasks to settle (cancelled executes reject, leases
    // release) — a task still running past stop() would outlive the process
    // with a live-looking lease.
    await Promise.allSettled([...this.activeTasks]);
    this.loop = null;
  }

  /** Cancels a task: marks CANCEL_REQUESTED, kills that task's process tree only. */
  requestCancel(taskId: string): void {
    const task = this.app.repositories.tasks.findById(taskId);
    if (!task) return;
    if (task.state === "RUNNING") this.app.repositories.tasks.update(taskId, { state: "CANCEL_REQUESTED" }, this.clock.now().toISOString());
    // Owner-scoped: other tasks' agents keep running.
    this.processRunner.cancelOwner(taskId);
    this.outbox.publish({ taskId, type: "task.cancel-requested", payload: { taskId } });
  }

  /**
   * Fail-stop without a state mark: kill the task's processes and let durable
   * recovery settle the outcome (FAILED). Used by timeout and lease loss —
   * neither is a user-requested cancel, and a CANCELLED task would fall out
   * of the CI-fix retry loop.
   */
  private failStopTask(taskId: string): void {
    this.processRunner.cancelOwner(taskId);
  }

  /**
   * CI/review fix path: FAILED tasks with pending github fix triggers are
   * reopened into a fix workflow and enqueued. Invoked from the poll loop so
   * `github refresh/reviews` alone eventually triggers the fix run.
   */
  async runPendingFixes(): Promise<{ taskId: string; runId: string }[]> {
    const started: { taskId: string; runId: string }[] = [];
    // Only tasks with unconsumed triggers are candidates; a bound-but-unfinished
    // fix run is skipped by the activeRunId check below.
    const rows = this.db.prepare(`SELECT DISTINCT task_id FROM github_fix_events WHERE consumed_by_run IS NULL`).all() as { task_id: string }[];
    for (const { task_id: taskId } of rows) {
      const task = this.app.repositories.tasks.findById(taskId);
      if (!task || task.state !== "FAILED") continue;
      if (this.activeRunId(taskId) !== null) continue; // a run is already open
      try {
        // Reopen + start + enqueue commit as one operation: a concurrent
        // recovery must never see a QUEUED run without its queue entry.
        const { runId } = withImmediateTransaction(this.db, () => {
          const startedFix = this.app.github.startFixWorkflow(taskId, (input) => this.app.workflows.start(input));
          this.queue.enqueue(taskId);
          return startedFix;
        });
        started.push({ taskId, runId });
        this.outbox.publish({ taskId, workflowRunId: runId, type: "fix.started", payload: { taskId, runId } });
      } catch {
        // Not startable right now (no worktree, mid-transition): retried on the next sweep.
      }
    }
    return started;
  }

  private async runLoop(): Promise<void> {
    const pollMs = this.options.pollMs ?? DEFAULTS.pollMs;
    const heartbeatMs = this.options.heartbeatMs ?? DEFAULTS.heartbeatMs;
    let lastReap = 0;
    while (!this.stopped) {
      // Top-level fault boundary: a transient DB error (lock contention with
      // another process, ...) must never kill the loop and leave queued work
      // unowned. Log and retry on the next poll.
      try {
        // Periodic reaping: recover tasks orphaned by crashed workers while we run.
        if (this.clock.now().getTime() - lastReap >= 5 * pollMs) {
          lastReap = this.clock.now().getTime();
          this.recoverOrphans();
          this.reapFinishedFixRuns();
          void this.runPendingFixes().catch(() => undefined);
        }
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
        // The queue entry is consumed at claim time: a later re-enqueue (e.g. an
        // approval resuming the run) is a fresh signal that must survive this
        // execution — never delete it in a finally by task_id.
        this.queue.dequeue(entry.taskId);
        const running = this.runTask(entry.taskId, leaseKey, heartbeatMs);
        this.activeTasks.add(running);
        // then() with both handlers: finally() would derive an unobserved
        // rejected promise when runTask fails.
        void running.then(
          () => { this.activeTasks.delete(running); },
          () => { this.activeTasks.delete(running); },
        );
        await sleep(pollMs);
      } catch (error) {
        console.error(`[agentdock] orchestrator poll error: ${error instanceof Error ? error.message : String(error)}`);
        await sleep(pollMs);
      }
    }
  }

  private async runTask(taskId: string, leaseKey: string, heartbeatMs: number): Promise<void> {
    const leaseTtlMs = this.options.leaseTtlMs ?? DEFAULTS.leaseTtlMs;
    let lastRenewedAt = Date.now();
    const heartbeat = setInterval(() => {
      try {
        if (this.leases.heartbeat(leaseKey, this.workerId, leaseTtlMs)) { lastRenewedAt = Date.now(); return; }
        this.failStopTask(taskId); // lease definitively lost (taken over or released)
      } catch {
        // Transient DB error (e.g. lock contention): the lease state is
        // unknown. Only fail-stop once the lease is provably expired — from
        // then on another worker may take over, and two writers must never run.
        if (Date.now() - lastRenewedAt >= leaseTtlMs) this.failStopTask(taskId);
      }
    }, heartbeatMs);
    // Hard task timeout: kill the task's processes; the execute() promise
    // rejects with the cancellation and recovery settles the task FAILED.
    // Deliberately NOT requestCancel: timeout is not a user cancel, and
    // CANCELLED tasks are invisible to the CI-fix retry loop.
    const timeout = setTimeout(() => {
      this.outbox.publish({ taskId, type: "task.timeout", payload: { taskId } });
      this.failStopTask(taskId);
    }, this.options.taskTimeoutMs ?? DEFAULTS.taskTimeoutMs);
    try {
      const activeRun = this.activeRunId(taskId);
      if (activeRun === null) throw new Error(`Task ${taskId} has no run to execute`);
      const status = await this.app.workflows.execute(activeRun);
      this.outbox.publish({ taskId, workflowRunId: activeRun, type: `run.${status.run.state.toLowerCase()}`, payload: { taskId, runId: activeRun, state: status.run.state } });
    } catch (error) {
      this.outbox.publish({ taskId, type: "run.worker-error", payload: { taskId, message: error instanceof Error ? error.message : String(error) } });
      // execute() threw (crash, worker error): the run is left non-terminal.
      // Trigger reaping below is durable-state driven, so it settles this run
      // on the next poll loop once the engine records its terminal state.
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      this.leases.release(leaseKey, this.workerId);
      this.reapFinishedFixRuns();
    }
  }

  /**
   * One-shot inline claim (CLI `workflow execute`). Applies the same
   * scheduling gate as the poll loop (project must be ACTIVE), takes the task
   * lease, and consumes the queue entry only when runId is the task's active
   * run — inline execution must not bypass scheduling or eat another run's
   * pending signal. On success the caller owns the lease and must
   * heartbeat/release it.
   */
  claimInlineRun(taskId: string, runId: string, owner: string, leaseTtlMs: number): { heartbeat(): "ok" | "lost" | "unknown"; release(): void } {
    const task = this.app.repositories.tasks.findById(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    const project = this.app.repositories.projects.findById(task.projectId);
    if (project?.status !== "ACTIVE") throw new Error(`Project is ${project?.status ?? "unknown"}; inline execution is blocked by the scheduling gate`);
    const leaseKey = `task:${taskId}`;
    if (!this.leases.acquire(leaseKey, owner, taskId, leaseTtlMs)) throw new Error(`Task ${taskId} is owned by a running orchestrator; watch it with: workflow status --run-id ${runId}`);
    try {
      withImmediateTransaction(this.db, () => {
        const active = this.queue.activeRunId(taskId);
        if (active !== null && active !== runId) throw new Error(`Run ${runId} is not the task's active run; use workflow status to find the current run`);
        this.queue.dequeue(taskId);
      });
    } catch (error) {
      this.leases.release(leaseKey, owner);
      throw error;
    }
    return {
      // "lost" = definitively not ours (taken over or released); "unknown" =
      // transient DB error — the caller decides how much uncertainty to
      // tolerate before failing stop.
      heartbeat: (): "ok" | "lost" | "unknown" => {
        try { return this.leases.heartbeat(leaseKey, owner, leaseTtlMs) ? "ok" : "lost"; } catch { return "unknown"; }
      },
      release: () => this.leases.release(leaseKey, owner),
    };
  }

  /**
   * Fix-trigger lifecycle, driven by durable run state rather than call sites:
   * a run bound to triggers is settled as soon as it reaches a terminal state —
   * SUCCEEDED clears its triggers for good; any other terminal state (FAILED,
   * CANCELLED, including runs cancelled by orphan recovery after a process
   * crash) unbinds them so the next sweep retries with the same feedback.
   * Runs still open are left alone. Safe to call repeatedly.
   */
  reapFinishedFixRuns(): void {
    const rows = this.db.prepare(`
      SELECT DISTINCT consumed_by_run AS runId, r.state AS state
      FROM github_fix_events f
      LEFT JOIN workflow_runs r ON r.id = f.consumed_by_run
      WHERE f.consumed_by_run IS NOT NULL`).all() as { runId: string; state: string | null }[];
    for (const row of rows) {
      if (row.state === "SUCCEEDED") {
        this.app.github.clearConsumedTriggers(row.runId);
      } else if (row.state === "FAILED" || row.state === "CANCELLED") {
        this.db.prepare("UPDATE github_fix_events SET consumed_by_run = NULL WHERE consumed_by_run = ?").run(row.runId);
      }
      // state null (run row gone) or non-terminal (QUEUED/RUNNING/...): leave bound.
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
