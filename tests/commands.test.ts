import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db/database.js";
import { createApplication } from "../src/app/application.js";
import { createRepository } from "./helpers.js";
import { TaskQueue } from "../src/reliability/task-queue.js";
import { TransactionalOutbox } from "../src/reliability/outbox.js";
import { StateConflictError } from "../src/shared/domain.js";
import type { CodingAgent } from "../src/runtime/coding-agent.js";
import type { WorkflowStatus } from "../src/workflows/workflow-engine.js";
import { startRun, approveRun, cancelRun, retryRun, createTask, isReplayed, type CommandContext } from "../src/commands/task-commands.js";

function fixture(options: { fakeAgents?: boolean } = {}) {
  const base = mkdtempSync(join(tmpdir(), "agentdock-cmd-"));
  createRepository(join(base, "repo"));
  const db = openDatabase(":memory:");
  const fakeAgent: CodingAgent = { provider: "fake", async run() { return { exitCode: 0, stdout: "VERDICT: PASS", stderr: "", externalSessionId: "s", resumed: false }; } };
  const app = createApplication(db, options.fakeAgents === true ? { agents: { claude: fakeAgent, codex: fakeAgent } } : {});
  const ctx: CommandContext = { db, app, queue: new TaskQueue(db), outbox: new TransactionalOutbox(db), activity: app.activity, audit: app.audit };
  return { base, db, app, ctx };
}

/** Drives a careful-preset run to its first approval gate. */
async function parkAtGate(f: ReturnType<typeof fixture>, runId: string): Promise<void> {
  const status = await f.app.workflows.execute(runId);
  if (!status.awaitingApproval) throw new Error(`run ${runId} did not park at a gate`);
}

function project(f: ReturnType<typeof fixture>): string {
  return f.app.projects.create({ name: `p-${Math.random().toString(36).slice(2)}`, repoPath: join(f.base, "repo"), worktreeRoot: join(f.base, "wt") }).id;
}

function runCount(db: ReturnType<typeof openDatabase>, taskId: string): number {
  return Number((db.prepare("SELECT COUNT(*) c FROM workflow_runs wr JOIN task_revisions tr ON wr.task_revision_id = tr.id WHERE tr.task_id = ?").get(taskId) as { c: number }).c);
}

test("startRun prepares a DRAFT task and commits run + queue entry together", async () => {
  const f = fixture();
  try {
    const { task } = f.app.tasks.create(project(f), "do it");
    const started = await startRun(f.ctx, { taskId: task.id, preset: "fast", actor: "test" }) as WorkflowStatus;
    assert.equal(started.run.state, "QUEUED");
    assert.equal(f.app.repositories.tasks.findById(task.id)!.state, "RUNNING");
    // The queue entry exists alongside the run (atomic start+enqueue).
    assert.equal(f.ctx.queue.size(), 1);
    assert.equal(f.ctx.queue.activeRunId(task.id), started.run.id);
    const types = f.app.activity.listSince(0, 100).map((e) => e.type);
    assert.ok(types.includes("task.prepared") && types.includes("run.queued"));
    const audit = f.app.audit.list({ taskId: task.id });
    assert.ok(audit.some((e) => e.action === "run.start" && e.actor === "test"));
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("approveRun on a run without a pending gate conflicts; second approve after reject conflicts", async () => {
  const f = fixture({ fakeAgents: true });
  try {
    const projectId = project(f);
    // No HUMAN_APPROVAL gate at all (fast preset).
    const { task: fast } = f.app.tasks.create(projectId, "fast task");
    const fastRun = await startRun(f.ctx, { taskId: fast.id, preset: "fast", actor: "test" }) as WorkflowStatus;
    await assert.rejects(approveRun(f.ctx, { runId: fastRun.run.id, approved: true, actor: "test" }), StateConflictError);

    // A gate that is merely QUEUED but not pending (earlier steps unfinished) cannot be decided.
    const { task: early } = f.app.tasks.create(projectId, "early gate");
    const earlyRun = await startRun(f.ctx, { taskId: early.id, preset: "careful", actor: "test" }) as WorkflowStatus;
    await assert.rejects(approveRun(f.ctx, { runId: earlyRun.run.id, approved: true, actor: "test" }), /no pending approval gate/);

    // Reject settles a parked run; any later decision is a stale-state conflict.
    const { task: careful } = f.app.tasks.create(projectId, "careful task");
    const carefulRun = await startRun(f.ctx, { taskId: careful.id, preset: "careful", actor: "test" }) as WorkflowStatus;
    await parkAtGate(f, carefulRun.run.id);
    const rejected = await approveRun(f.ctx, { runId: carefulRun.run.id, approved: false, actor: "test" }) as WorkflowStatus;
    assert.equal(rejected.run.state, "CANCELLED");
    await assert.rejects(approveRun(f.ctx, { runId: carefulRun.run.id, approved: true, actor: "test" }), StateConflictError);
    const decided = f.app.activity.listSince(0, 100).filter((e) => e.type === "approval.decided");
    assert.equal(decided.length, 1);
    assert.equal(decided[0]!.actor, "test");
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("cancelRun settles run and task; a second cancel conflicts", async () => {
  const f = fixture();
  try {
    const { task } = f.app.tasks.create(project(f), "do it");
    const started = await startRun(f.ctx, { taskId: task.id, preset: "fast", actor: "test" }) as WorkflowStatus;
    const cancelled = await cancelRun(f.ctx, { runId: started.run.id, actor: "test" }) as WorkflowStatus;
    assert.equal(cancelled.run.state, "CANCELLED");
    assert.equal(f.app.repositories.tasks.findById(task.id)!.state, "CANCELLED");
    const types = f.app.activity.listSince(0, 100).map((e) => e.type);
    assert.ok(types.includes("run.cancelled") && types.includes("task.cancelled"));
    await assert.rejects(cancelRun(f.ctx, { runId: started.run.id, actor: "test" }), StateConflictError);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("retryRun reopens a cancelled task with the old preset and provider assignment", async () => {
  const f = fixture();
  try {
    const { task } = f.app.tasks.create(project(f), "do it");
    const started = await startRun(f.ctx, { taskId: task.id, preset: "cross-review", providers: { IMPLEMENT: "codex" }, actor: "test" }) as WorkflowStatus;
    await cancelRun(f.ctx, { runId: started.run.id, actor: "test" });
    f.ctx.queue.dequeue(task.id);

    const retried = await retryRun(f.ctx, { runId: started.run.id, actor: "test" }) as WorkflowStatus;
    assert.notEqual(retried.run.id, started.run.id);
    assert.equal(retried.run.preset, "cross-review");
    assert.equal(retried.steps.find((s) => s.stepType === "IMPLEMENT")!.provider, "codex", "provider assignment survives the retry");
    assert.equal(f.app.repositories.tasks.findById(task.id)!.state, "RUNNING");
    assert.equal(f.ctx.queue.activeRunId(task.id), retried.run.id);
    assert.equal(runCount(f.db, task.id), 2);

    // Guard: only the latest run is retryable.
    await assert.rejects(retryRun(f.ctx, { runId: started.run.id, actor: "test" }), /not the task's latest run/);
    // Guard: a non-terminal run is not retryable.
    await assert.rejects(retryRun(f.ctx, { runId: retried.run.id, actor: "test" }), /only finished runs can be retried/);
    // Guard: reopenForRetry refuses tasks that are not FAILED/CANCELLED.
    assert.throws(() => f.app.tasks.reopenForRetry(task.id), StateConflictError);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("idempotency replay returns the stored response without a second run", async () => {
  const f = fixture();
  try {
    const { task } = f.app.tasks.create(project(f), "do it");
    const first = await startRun(f.ctx, { taskId: task.id, preset: "fast", actor: "test", idempotencyKey: "k1" }) as WorkflowStatus;
    const second = await startRun(f.ctx, { taskId: task.id, preset: "fast", actor: "test", idempotencyKey: "k1" });
    assert.ok(isReplayed(second));
    assert.equal((second.response as WorkflowStatus).run.id, first.run.id);
    assert.equal(runCount(f.db, task.id), 1, "replayed start creates no second run");

    const created = await createTask(f.ctx, { projectId: f.app.repositories.tasks.findById(task.id)!.projectId, request: "again", actor: "test", idempotencyKey: "k2" });
    assert.ok(!isReplayed(created));
    const replayed = await createTask(f.ctx, { projectId: f.app.repositories.tasks.findById(task.id)!.projectId, request: "again", actor: "test", idempotencyKey: "k2" });
    assert.ok(isReplayed(replayed));
    assert.equal(f.app.tasks.list().length, 2, "replayed create adds no task");
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("retryRun accepts a provider override (swap-and-rerun)", async () => {
  const f = fixture();
  try {
    const { task } = f.app.tasks.create(project(f), "do it");
    const started = await startRun(f.ctx, { taskId: task.id, preset: "cross-review", providers: { IMPLEMENT: "codex", REVIEW: "claude" }, actor: "test" }) as WorkflowStatus;
    await cancelRun(f.ctx, { runId: started.run.id, actor: "test" });
    f.ctx.queue.dequeue(task.id);

    // Plain retry recovers the old assignment.
    const retried = await retryRun(f.ctx, { runId: started.run.id, actor: "test" }) as WorkflowStatus;
    assert.equal(retried.steps.find((s) => s.stepType === "IMPLEMENT")!.provider, "codex");
    await cancelRun(f.ctx, { runId: retried.run.id, actor: "test" });
    f.ctx.queue.dequeue(task.id);

    // Override swaps implementer/reviewer.
    const swapped = await retryRun(f.ctx, { runId: retried.run.id, providers: { IMPLEMENT: "claude", FIX: "claude", PLAN: "claude", REVIEW: "codex", FINAL_REVIEW: "codex" }, actor: "test" }) as WorkflowStatus;
    assert.equal(swapped.steps.find((s) => s.stepType === "IMPLEMENT")!.provider, "claude");
    assert.equal(swapped.steps.find((s) => s.stepType === "REVIEW")!.provider, "codex");
    assert.equal(runCount(f.db, task.id), 3);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("retryRun keeps the original run's bounds and rejects SUCCEEDED runs", async () => {
  const f = fixture();
  try {
    const { task } = f.app.tasks.create(project(f), "do it");
    const started = await startRun(f.ctx, { taskId: task.id, preset: "cross-review", maxReviewRounds: 2, stepTimeoutMs: 60_000, actor: "test" }) as WorkflowStatus;
    await cancelRun(f.ctx, { runId: started.run.id, actor: "test" });
    f.ctx.queue.dequeue(task.id);
    const retried = await retryRun(f.ctx, { runId: started.run.id, actor: "test" }) as WorkflowStatus;
    assert.equal(retried.run.maxReviewRounds, 2, "retry keeps maxReviewRounds");
    assert.equal(retried.run.stepTimeoutMs, 60_000, "retry keeps stepTimeoutMs");

    // SUCCEEDED runs are not retryable: revise instead.
    await cancelRun(f.ctx, { runId: retried.run.id, actor: "test" });
    f.ctx.queue.dequeue(task.id);
    const second = await retryRun(f.ctx, { runId: retried.run.id, actor: "test" }) as WorkflowStatus;
    f.app.repositories.tasks.update(task.id, { state: "SUCCEEDED" }, new Date().toISOString());
    f.db.prepare("UPDATE workflow_runs SET state = 'SUCCEEDED' WHERE id = ?").run(second.run.id);
    await assert.rejects(retryRun(f.ctx, { runId: second.run.id, actor: "test" }), /succeeded; retry is for failed\/cancelled runs/);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("commands layer validates providers (unknown step/provider)", async () => {
  const f = fixture();
  try {
    const { task } = f.app.tasks.create(project(f), "do it");
    await assert.rejects(
      startRun(f.ctx, { taskId: task.id, preset: "fast", providers: { IMPLEMENT: "gpt-x" }, actor: "test" }),
      /unknown provider gpt-x/,
    );
    await assert.rejects(
      startRun(f.ctx, { taskId: task.id, preset: "fast", providers: { DEPLOY: "claude" } as never, actor: "test" }),
      /unknown step type DEPLOY/,
    );
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("expectedRunState guard: mismatch conflicts before acting, match proceeds", async () => {
  const f = fixture({ fakeAgents: true });
  try {
    const { task } = f.app.tasks.create(project(f), "do it");
    const started = await startRun(f.ctx, { taskId: task.id, preset: "careful", actor: "test" }) as WorkflowStatus;
    await parkAtGate(f, started.run.id);
    // Parked at the gate: run state is RUNNING.
    await assert.rejects(
      approveRun(f.ctx, { runId: started.run.id, approved: true, expectedRunState: "QUEUED", actor: "test" }),
      StateConflictError,
    );
    const approved = await approveRun(f.ctx, { runId: started.run.id, approved: true, expectedRunState: "RUNNING", actor: "test" }) as WorkflowStatus;
    assert.equal(approved.steps.filter((s) => s.stepType === "HUMAN_APPROVAL")[0]!.state, "SUCCEEDED");
    // Cancel with a stale expectation conflicts and leaves the run untouched.
    await assert.rejects(cancelRun(f.ctx, { runId: started.run.id, expectedRunState: "CANCELLED", actor: "test" }), StateConflictError);
    assert.equal(f.app.workflows.status(started.run.id).run.state, "RUNNING");
    // Retry with matching expectation passes the guard and fails later on state semantics.
    await assert.rejects(retryRun(f.ctx, { runId: started.run.id, expectedRunState: "RUNNING", actor: "test" }), /only finished runs/);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("approval binds to the pending gate: a stale gate-1 request cannot decide gate 2", async () => {
  const f = fixture({ fakeAgents: true });
  try {
    const { task } = f.app.tasks.create(project(f), "two gates");
    const started = await startRun(f.ctx, { taskId: task.id, preset: "careful", actor: "test" }) as WorkflowStatus;
    await parkAtGate(f, started.run.id);
    const gate1 = f.app.workflows.pendingApprovalGate(started.run.id)!;
    // Fresh request bound to gate 1 proceeds.
    await approveRun(f.ctx, { runId: started.run.id, approved: true, expectedApprovalStepId: gate1.id, actor: "test" });
    // Drive to the second gate (fake reviews PASS).
    const parked2 = await f.app.workflows.execute(started.run.id);
    assert.equal(parked2.awaitingApproval, true);
    const gate2 = f.app.workflows.pendingApprovalGate(started.run.id)!;
    assert.notEqual(gate2.id, gate1.id);
    // expectedRunState alone cannot detect the stale view (still RUNNING).
    const stale = await approveRun(f.ctx, { runId: started.run.id, approved: true, expectedRunState: "RUNNING", expectedApprovalStepId: gate1.id, actor: "stale-ui" }).catch((error: Error) => error);
    assert.ok(stale instanceof StateConflictError, `stale gate request must conflict, got ${String(stale)}`);
    assert.equal(f.app.workflows.pendingApprovalGate(started.run.id)?.id, gate2.id, "gate 2 still pending after the stale request");
    // The correct binding decides it.
    const done = await approveRun(f.ctx, { runId: started.run.id, approved: true, expectedApprovalStepId: gate2.id, actor: "test" }) as WorkflowStatus;
    await f.app.workflows.execute(started.run.id);
    assert.ok(["SUCCEEDED", "RUNNING"].includes(done.run.state));
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("idempotency crash windows: pre-commit claims reclaim without duplicates; committed effects replay", async () => {
  const f = fixture();
  try {
    const projectId = project(f);
    const taskCount = (request: string) => Number((f.db.prepare("SELECT COUNT(*) c FROM tasks t JOIN task_revisions r ON r.task_id = t.id WHERE t.project_id = ? AND r.request = ?").get(projectId, request) as { c: number }).c);
    const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString();

    // Window 1 — crash BEFORE the domain commit: a stale answerless claim and
    // no committed effect. Reclaim re-executes and creates exactly one task.
    f.db.prepare("INSERT INTO command_dedup (command_key, created_at) VALUES (?, ?)").run("http:crash-pre", hourAgo);
    const reclaimed = await createTask(f.ctx, { projectId, request: "pre", actor: "test", idempotencyKey: "crash-pre" });
    assert.ok(!isReplayed(reclaimed));
    assert.equal(taskCount("pre"), 1, "no duplicate task from the reclaimed claim");

    // Window 2 — crash AFTER the domain commit: with transactional responses
    // the response is committed with the effect, so a retry replays it.
    const committed = await createTask(f.ctx, { projectId, request: "post", actor: "test", idempotencyKey: "crash-post" });
    assert.ok(!isReplayed(committed));
    const replayed = await createTask(f.ctx, { projectId, request: "post", actor: "test", idempotencyKey: "crash-post" });
    assert.ok(isReplayed(replayed), "committed effect replays its stored response");
    assert.equal(taskCount("post"), 1, "replay creates no second task");

    // Revisions are creation-shaped too: a reclaimed claim appends exactly one.
    const { task } = f.app.tasks.create(projectId, "revise me");
    f.db.prepare("INSERT INTO command_dedup (command_key, created_at) VALUES (?, ?)").run("http:crash-rev", hourAgo);
    const { reviseTask } = await import("../src/commands/task-commands.js");
    const revision = await reviseTask(f.ctx, { taskId: task.id, request: "again", actor: "test", idempotencyKey: "crash-rev" }) as { revision: number };
    assert.equal(revision.revision, 2);
    assert.equal(f.app.tasks.show(task.id).revisions.length, 2, "no duplicate revision from the reclaimed claim");

    // A genuinely in-flight claim (recent, answerless) still conflicts.
    f.db.prepare("INSERT INTO command_dedup (command_key, created_at) VALUES (?, ?)").run("http:in-flight-1", new Date().toISOString());
    await assert.rejects(createTask(f.ctx, { projectId, request: "inflight", actor: "test", idempotencyKey: "in-flight-1" }), /request in progress/);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("revise/retry ordering converges: revising an active task keeps RUNNING; retry after a revise-driven reopen conflicts", async () => {
  const f = fixture({ fakeAgents: true });
  try {
    const projectId = project(f);
    // A run is active (startRun leaves the task RUNNING until execution finishes).
    const { task } = f.app.tasks.create(projectId, "active task");
    const started = await startRun(f.ctx, { taskId: task.id, preset: "fast", actor: "test" }) as WorkflowStatus;
    assert.equal(f.app.repositories.tasks.findById(task.id)!.state, "RUNNING");
    const { reviseTask } = await import("../src/commands/task-commands.js");
    await reviseTask(f.ctx, { taskId: task.id, request: "changed mid-flight", actor: "test" });
    assert.equal(f.app.repositories.tasks.findById(task.id)!.state, "RUNNING", "revise must never overwrite an active run's state back to READY");
    await f.app.workflows.execute(started.run.id); // settle to SUCCEEDED

    // Reverse order: revise reopens the terminal task, then a retry of the old
    // run must NOT open a second run on top of the reopened revision.
    await reviseTask(f.ctx, { taskId: task.id, request: "follow-up", actor: "test" });
    assert.equal(f.app.repositories.tasks.findById(task.id)!.state, "READY");
    await assert.rejects(retryRun(f.ctx, { runId: started.run.id, actor: "test" }), StateConflictError, "retry cannot reopen a task the revision already reopened");
    assert.equal(runCount(f.db, task.id), 1, "exactly one run exists");
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("revising a SUCCEEDED task reopens it: the follow-up revision can start a new run", async () => {
  const f = fixture({ fakeAgents: true });
  try {
    const { task } = f.app.tasks.create(project(f), "done then extended");
    const started = await startRun(f.ctx, { taskId: task.id, preset: "fast", actor: "test" }) as WorkflowStatus;
    const finished = await f.app.workflows.execute(started.run.id);
    assert.equal(finished.run.state, "SUCCEEDED");
    assert.equal(f.app.repositories.tasks.findById(task.id)!.state, "SUCCEEDED");
    const { reviseTask } = await import("../src/commands/task-commands.js");
    const revision = await reviseTask(f.ctx, { taskId: task.id, request: "extend it", actor: "test" }) as { revision: number };
    assert.equal(revision.revision, 2);
    assert.equal(f.app.repositories.tasks.findById(task.id)!.state, "READY", "terminal task reopens for the new revision");
    const second = await startRun(f.ctx, { taskId: task.id, preset: "fast", actor: "test" }) as WorkflowStatus;
    assert.equal(runCount(f.db, task.id), 2);
    assert.notEqual(second.run.id, started.run.id);
    assert.equal(f.app.repositories.tasks.findById(task.id)!.state, "RUNNING");
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});
