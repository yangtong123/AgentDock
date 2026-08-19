import type { Database } from "../db/database.js";
import { withImmediateTransaction } from "../db/database.js";
import type { Application } from "../app/application.js";
import type { TaskQueue } from "../reliability/task-queue.js";
import { CommandDedup, TransactionalOutbox } from "../reliability/outbox.js";
import type { AuditLog } from "../security/permissions.js";
import { ACTIVITY_EVENTS, type ActivityLog } from "../activity/activity-log.js";
import { NotFoundError, StateConflictError, ValidationError, STEP_TYPES, type Task, type TaskDetails, type TaskRevision } from "../shared/domain.js";
import type { ProviderAssignment } from "../workflows/presets.js";
import type { WorkflowStatus } from "../workflows/workflow-engine.js";

/**
 * Shared command handlers used by the CLI, the IM controller, and the HTTP
 * gateway. Each handler owns its transaction boundary, activity event, and
 * audit entry; callers pass an actor and, for HTTP, an idempotency key.
 */
export interface CommandContext {
  db: Database;
  app: Application;
  queue: TaskQueue;
  /** Cancellation/terminal notifications for IM subscribers ride the outbox. */
  outbox: TransactionalOutbox;
  activity: ActivityLog;
  audit: AuditLog;
  orchestrator?: { requestCancel(taskId: string, actor?: string): void };
}

interface CommandCall {
  actor: string;
  idempotencyKey?: string;
}

/** A replayed idempotent request returns its originally stored response. */
export interface Replayed {
  replayed: true;
  response: unknown;
}

export function isReplayed(result: unknown): result is Replayed {
  return typeof result === "object" && result !== null && (result as { replayed?: unknown }).replayed === true;
}

/**
 * HTTP idempotency: the `http:{key}` dedup row is claimed before the handler
 * runs and carries the JSON response afterwards. A claimed row without a
 * response means a concurrent request is still in flight. Failures release
 * the key so the request stays retryable (same rule as Orchestrator.once).
 */
async function idempotent<T>(ctx: CommandContext, key: string | undefined, fn: () => Promise<T>): Promise<T | Replayed> {
  if (key === undefined) return fn();
  const dedup = new CommandDedup(ctx.db);
  const commandKey = `http:${key}`;
  if (!dedup.claim(commandKey)) {
    const existing = dedup.lookup(commandKey);
    if (existing.response !== null) return { replayed: true, response: JSON.parse(existing.response) };
    throw new StateConflictError(`request in progress`);
  }
  try {
    const value = await fn();
    dedup.storeResponse(commandKey, JSON.stringify(value ?? null));
    return value;
  } catch (error) {
    ctx.db.prepare("DELETE FROM command_dedup WHERE command_key = ?").run(commandKey);
    throw error;
  }
}

function taskIdForRun(db: Database, runId: string): string | null {
  const row = db.prepare("SELECT tr.task_id AS taskId FROM workflow_runs wr JOIN task_revisions tr ON wr.task_revision_id = tr.id WHERE wr.id = ?").get(runId) as { taskId: string } | undefined;
  return row?.taskId ?? null;
}

/** Provider-assignment validation shared by the commands layer and the IM controller. */
export function validateProviderAssignment(knownProviders: string[], providers: ProviderAssignment): void {
  for (const [step, provider] of Object.entries(providers)) {
    if (!(STEP_TYPES as readonly string[]).includes(step)) throw new ValidationError(`providers: unknown step type ${step} (expected ${STEP_TYPES.join(", ")})`);
    if (typeof provider !== "string" || !knownProviders.includes(provider)) throw new ValidationError(`providers: unknown provider ${String(provider)} for ${step} (known: ${knownProviders.join(", ")})`);
  }
}

/** Commands-layer provider validation (the gateway validates too — defense in depth). */
function validateProviders(ctx: CommandContext, providers: ProviderAssignment | undefined): void {
  if (providers === undefined) return;
  validateProviderAssignment(Object.keys(ctx.app.agents), providers);
}

/** Optimistic-concurrency guard: the caller's view of the run state must match. */
function requireRunState(ctx: CommandContext, runId: string, expected: string | undefined): void {
  if (expected === undefined) return;
  const run = ctx.app.repositories.workflows.findRun(runId);
  if (!run) throw new NotFoundError(`WorkflowRun ${runId} not found`);
  if (run.state !== expected) throw new StateConflictError(`WorkflowRun ${runId} is ${run.state}, expected ${expected}`);
}

export async function createTask(ctx: CommandContext, input: { projectId: string; request: string } & CommandCall): Promise<TaskDetails | Replayed> {
  return idempotent(ctx, input.idempotencyKey, () => {
    const details = ctx.app.tasks.create(input.projectId, input.request);
    ctx.activity.record({ type: ACTIVITY_EVENTS.taskCreated, taskId: details.task.id, actor: input.actor, payload: { projectId: input.projectId, request: details.currentRevision.request } });
    ctx.audit.record({ actor: input.actor, action: "task.create", taskId: details.task.id, detail: { projectId: input.projectId } });
    return Promise.resolve(details);
  });
}

export async function reviseTask(ctx: CommandContext, input: { taskId: string; request: string } & CommandCall): Promise<TaskRevision | Replayed> {
  return idempotent(ctx, input.idempotencyKey, () => {
    const revision = ctx.app.tasks.revise(input.taskId, input.request);
    ctx.activity.record({ type: ACTIVITY_EVENTS.taskRevised, taskId: input.taskId, actor: input.actor, payload: { revision: revision.revision, request: revision.request } });
    ctx.audit.record({ actor: input.actor, action: "task.revise", taskId: input.taskId, detail: { revision: revision.revision } });
    return Promise.resolve(revision);
  });
}

export async function prepareTask(ctx: CommandContext, input: { taskId: string } & CommandCall): Promise<Task | Replayed> {
  return idempotent(ctx, input.idempotencyKey, async () => {
    const task = await ctx.app.worktrees.prepare(input.taskId);
    ctx.activity.record({ type: ACTIVITY_EVENTS.taskPrepared, taskId: input.taskId, actor: input.actor, payload: { branch: task.branch, worktreePath: task.worktreePath } });
    ctx.audit.record({ actor: input.actor, action: "task.prepare", taskId: input.taskId });
    return task;
  });
}

export async function startRun(ctx: CommandContext, input: {
  taskId: string;
  preset: string;
  providers?: ProviderAssignment;
  maxReviewRounds?: number;
  stepTimeoutMs?: number;
  priority?: number;
  scheduledAt?: Date;
} & CommandCall): Promise<WorkflowStatus | Replayed> {
  return idempotent(ctx, input.idempotencyKey, async () => {
    validateProviders(ctx, input.providers);
    const task = ctx.app.repositories.tasks.findById(input.taskId);
    if (!task) throw new NotFoundError(`Task ${input.taskId} not found`);
    if (task.state === "DRAFT") await prepareTask(ctx, { taskId: input.taskId, actor: input.actor });
    // Start + enqueue + run.queued commit atomically: a running orchestrator
    // must never see a QUEUED run without its queue entry (orphan recovery).
    const started = withImmediateTransaction(ctx.db, () => {
      const s = ctx.app.workflows.start({
        taskId: input.taskId,
        preset: input.preset,
        ...(input.providers !== undefined ? { providers: input.providers } : {}),
        ...(input.maxReviewRounds !== undefined ? { maxReviewRounds: input.maxReviewRounds } : {}),
        ...(input.stepTimeoutMs !== undefined ? { stepTimeoutMs: input.stepTimeoutMs } : {}),
      });
      ctx.queue.enqueue(input.taskId, {
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt } : {}),
      });
      // Payload shape is the contract across surfaces: { preset, providers? }.
      ctx.activity.record({ type: ACTIVITY_EVENTS.runQueued, taskId: input.taskId, runId: s.run.id, actor: input.actor, payload: { preset: input.preset, ...(input.providers !== undefined && Object.keys(input.providers).length > 0 ? { providers: input.providers } : {}) } });
      return s;
    });
    ctx.audit.record({ actor: input.actor, action: "run.start", taskId: input.taskId, detail: { runId: started.run.id, preset: input.preset } });
    return started;
  });
}

export async function approveRun(ctx: CommandContext, input: { runId: string; approved: boolean; expectedRunState?: string } & CommandCall): Promise<WorkflowStatus | Replayed> {
  return idempotent(ctx, input.idempotencyKey, () => {
    const taskId = taskIdForRun(ctx.db, input.runId);
    // Approve + re-enqueue commit atomically (approval.decided is recorded by
    // the engine, with the actor). The expected-state check runs inside the
    // transaction so a concurrent decision cannot slip between check and act.
    const status = withImmediateTransaction(ctx.db, () => {
      requireRunState(ctx, input.runId, input.expectedRunState);
      const s = ctx.app.workflows.approve(input.runId, input.approved, { actor: input.actor });
      if (input.approved && taskId !== null) ctx.queue.enqueue(taskId);
      // Reject cancels a parked run: no worker is executing, so nobody else
      // will report the terminal state. run.cancelled is published here (in
      // the same transaction); an executing run's cancel is reported by the
      // orchestrator's runTask unwind instead — exactly one publisher per path.
      if (!input.approved && taskId !== null) ctx.outbox.publish({ taskId, workflowRunId: input.runId, type: "run.cancelled", payload: { taskId, runId: input.runId } });
      return s;
    });
    ctx.audit.record({ actor: input.actor, action: input.approved ? "run.approve" : "run.reject", ...(taskId !== null ? { taskId } : {}), detail: { runId: input.runId } });
    return Promise.resolve(status);
  });
}

export async function cancelRun(ctx: CommandContext, input: { runId: string; expectedRunState?: string } & CommandCall): Promise<WorkflowStatus | Replayed> {
  return idempotent(ctx, input.idempotencyKey, () => {
    requireRunState(ctx, input.runId, input.expectedRunState);
    const taskId = taskIdForRun(ctx.db, input.runId);
    const task = taskId !== null ? ctx.app.repositories.tasks.findById(taskId) : undefined;
    const wasRunning = task?.state === "RUNNING";
    const status = ctx.app.workflows.cancel(input.runId);
    // A live task's agent processes must die with the run; requestCancel also
    // records task.cancel-requested into the activity stream.
    if (wasRunning && taskId !== null && ctx.orchestrator !== undefined) ctx.orchestrator.requestCancel(taskId, input.actor);
    if (taskId !== null) {
      // A queued-but-never-claimed run must not be picked up after cancellation.
      ctx.queue.dequeue(taskId);
      // Publisher split (exactly once): a live lease means a worker is
      // executing and its runTask unwind publishes run.cancelled; otherwise
      // (queued, parked at a gate) nobody else will, so we publish here.
      const leased = ctx.db.prepare("SELECT 1 AS x FROM worker_leases WHERE task_id = ? AND expires_at > ?").get(taskId, new Date().toISOString()) !== undefined;
      if (!leased) ctx.outbox.publish({ taskId, workflowRunId: input.runId, type: "run.cancelled", payload: { taskId, runId: input.runId } });
    }
    ctx.audit.record({ actor: input.actor, action: "run.cancel", ...(taskId !== null ? { taskId } : {}), detail: { runId: input.runId } });
    return Promise.resolve(status);
  });
}

/** Retries a failed/cancelled run: task reopens, same preset/bounds and provider assignment (unless overridden), fresh run enqueued. */
export async function retryRun(ctx: CommandContext, input: { runId: string; providers?: ProviderAssignment; expectedRunState?: string } & CommandCall): Promise<WorkflowStatus | Replayed> {
  return idempotent(ctx, input.idempotencyKey, () => {
    validateProviders(ctx, input.providers);
    const run = ctx.app.repositories.workflows.findRun(input.runId);
    if (!run) throw new NotFoundError(`WorkflowRun ${input.runId} not found`);
    requireRunState(ctx, input.runId, input.expectedRunState);
    if (run.state === "SUCCEEDED") {
      throw new StateConflictError(`WorkflowRun ${input.runId} succeeded; retry is for failed/cancelled runs — revise the task to run again`);
    }
    if (run.state !== "FAILED" && run.state !== "CANCELLED") {
      throw new StateConflictError(`WorkflowRun ${input.runId} is ${run.state}; only finished runs can be retried`);
    }
    const revision = ctx.app.repositories.tasks.findRevisionById(run.taskRevisionId);
    if (!revision) throw new NotFoundError(`TaskRevision ${run.taskRevisionId} not found`);
    const taskId = revision.taskId;
    // rowid breaks created_at ties: insertion order, not random UUID order.
    const latest = ctx.db.prepare("SELECT wr.id AS id FROM workflow_runs wr JOIN task_revisions tr ON wr.task_revision_id = tr.id WHERE tr.task_id = ? ORDER BY wr.created_at DESC, wr.rowid DESC LIMIT 1").get(taskId) as { id: string } | undefined;
    if (latest?.id !== run.id) throw new StateConflictError(`WorkflowRun ${input.runId} is not the task's latest run; retry that one instead`);
    const task = ctx.app.repositories.tasks.findById(taskId);
    if (task && (task.state === "RUNNING" || task.state === "CANCEL_REQUESTED")) {
      throw new StateConflictError(`Task ${taskId} is ${task.state}; cannot retry while a run is active`);
    }
    // Caller-supplied assignment wins (swap-and-rerun); otherwise recover the
    // old run's assignment so role swaps survive retries.
    let providers: ProviderAssignment = {};
    if (input.providers !== undefined) {
      providers = input.providers;
    } else {
      for (const step of ctx.app.repositories.workflows.listSteps(run.id)) {
        if (step.stepType !== "HUMAN_APPROVAL" && step.provider !== null) providers[step.stepType] = step.provider;
      }
    }
    const preset = run.preset ?? "cross-review";
    const started = withImmediateTransaction(ctx.db, () => {
      ctx.app.tasks.reopenForRetry(taskId);
      // Retried runs keep the original bounds (review rounds, step timeout).
      const s = ctx.app.workflows.start({ taskId, preset, providers, maxReviewRounds: run.maxReviewRounds, stepTimeoutMs: run.stepTimeoutMs });
      ctx.queue.enqueue(taskId);
      ctx.activity.record({ type: ACTIVITY_EVENTS.runQueued, taskId, runId: s.run.id, actor: input.actor, payload: { preset, retryOf: run.id } });
      return s;
    });
    ctx.audit.record({ actor: input.actor, action: "run.retry", taskId, detail: { runId: started.run.id, retryOf: run.id } });
    return Promise.resolve(started);
  });
}
