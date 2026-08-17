import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db/database.js";
import { createApplication } from "../src/app/application.js";
import { createRepository } from "./helpers.js";
import { Orchestrator } from "../src/reliability/orchestrator.js";
import { ProcessRunner } from "../src/runtime/process-runner.js";
import { AgentThreadManager } from "../src/runtime/agent-thread-manager.js";
import { SqliteAgentThreadRepository } from "../src/agents/agent-thread-repository.js";
import { SqliteArtifactRepository } from "../src/artifacts/artifact-repository.js";
import { SqliteTaskRepository } from "../src/tasks/task-repository.js";
import { WorkflowEngine } from "../src/workflows/workflow-engine.js";
import type { Clock } from "../src/reliability/outbox.js";

function fakeClock(startMs: number): Clock & { advance(ms: number): void } {
  let current = startMs;
  return { now: () => new Date(current), advance: (ms: number) => { current += ms; } };
}

interface Fixture {
  base: string;
  db: ReturnType<typeof openDatabase>;
  app: ReturnType<typeof createApplication>;
  orchestrator: Orchestrator;
  clock: Clock & { advance(ms: number): void };
  runtime: AgentThreadManager;
  runner: ProcessRunner;
}

function fixture(options: { pollMs?: number; agent?: { provider: string; run(): Promise<{ exitCode: number; stdout: string; stderr: string; externalSessionId: string; resumed: boolean }> } } = {}): Fixture {
  const base = mkdtempSync(join(tmpdir(), "agentdock-orch-"));
  createRepository(join(base, "repo"));
  const db = openDatabase(":memory:");
  const app = createApplication(db);
  const clock = fakeClock(Date.UTC(2026, 0, 1));
  // Fake agents so no real CLI runs.
  const fakeAgent = options.agent ?? { provider: "fake", async run() { return { exitCode: 0, stdout: "VERDICT: PASS", stderr: "", externalSessionId: "s", resumed: false }; } };
  const runtime = new AgentThreadManager(new SqliteAgentThreadRepository(db), new SqliteArtifactRepository(db), new SqliteTaskRepository(db), () => fakeAgent, join(base, "artifacts"));
  // One shared runner, like production: the orchestrator's cancel/timeout must
  // reach the engine's agent and verify processes.
  const runner = new ProcessRunner();
  // Swap in the fake runtime by rebuilding the engine with it.
  const fakeEngine = new WorkflowEngine(app.repositories.workflows, app.repositories.tasks, app.repositories.projects, runtime, new SqliteArtifactRepository(db), runner, process.env, () => clock.now().toISOString());
  (app as unknown as Record<string, unknown>).workflows = fakeEngine;
  const orchestrator = new Orchestrator(db, app, runner, { pollMs: options.pollMs ?? 10 }, clock);
  return { base, db, app, orchestrator, clock, runtime, runner };
}

async function queuedTask(f: Fixture, request = "do it"): Promise<string> {
  const project = f.app.projects.create({ name: `p-${Math.random().toString(36).slice(2)}`, repoPath: join(f.base, "repo"), worktreeRoot: join(f.base, "wt") });
  const { task } = f.app.tasks.create(project.id, request);
  await f.app.worktrees.prepare(task.id);
  await f.app.workflows.start({ taskId: task.id, preset: "fast" });
  f.orchestrator.queue.enqueue(task.id);
  return task.id;
}

test("orchestrator runs a queued task to completion under a lease", async () => {
  const f = fixture();
  try {
    const taskId = await queuedTask(f);
    await f.orchestrator.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await f.orchestrator.stop();
    assert.equal(f.app.tasks.list().find((t) => t.id === taskId)!.state, "SUCCEEDED");
    assert.equal(f.orchestrator.queue.size(), 0);
    // Outbox recorded the run completion.
    const events = f.db.prepare("SELECT type FROM outbox_events WHERE task_id = ?").all(taskId) as { type: string }[];
    assert.ok(events.some((e) => e.type === "run.succeeded"), `events: ${JSON.stringify(events)}`);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("stop() waits for in-flight tasks to settle after cancellation", async () => {
  let releaseAgent!: () => void;
  const gate = new Promise<void>((resolve) => { releaseAgent = resolve; });
  const blockingAgent = { provider: "fake", async run() { await gate; return { exitCode: 0, stdout: "VERDICT: PASS", stderr: "", externalSessionId: "s", resumed: false }; } };
  const f = fixture({ pollMs: 10, agent: blockingAgent });
  try {
    const taskId = await queuedTask(f);
    await f.orchestrator.start();
    // Wait until the run is actually executing its first step.
    for (let i = 0; i < 100; i++) {
      const running = f.db.prepare("SELECT COUNT(*) c FROM step_runs WHERE state = 'RUNNING'").get() as { c: number };
      if (running.c > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    let stopped = false;
    const stopPromise = f.orchestrator.stop().then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(stopped, false, "stop must wait for the in-flight runTask, not just the poll loop");
    releaseAgent();
    await stopPromise;
    assert.equal(stopped, true);
    assert.equal(f.orchestrator.queue.size(), 0);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("activeRunId distinguishes the current open run from a stale terminal one", async () => {
  const f = fixture();
  try {
    const taskId = await queuedTask(f);
    const staleRunId = f.orchestrator.queue.activeRunId(taskId)!;
    assert.notEqual(staleRunId, null);
    f.app.workflows.cancel(staleRunId);
    f.app.repositories.tasks.update(taskId, { state: "READY" }, f.clock.now().toISOString());
    const started = f.app.workflows.start({ taskId, preset: "fast" });
    f.orchestrator.queue.enqueue(taskId);
    assert.equal(f.orchestrator.queue.activeRunId(taskId), started.run.id, "the newer run is the active one");
    assert.notEqual(f.orchestrator.queue.activeRunId(taskId), staleRunId, "a stale run-id must not be accepted as active");
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("orchestrator.once executes an action exactly once", async () => {  const f = fixture();
  try {
    let executions = 0;
    const action = async () => { executions++; };
    assert.equal(await f.orchestrator.once("approve:r1", action), true);
    assert.equal(await f.orchestrator.once("approve:r1", action), false);
    assert.equal(executions, 1);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("task timeout during VERIFY settles FAILED, not CANCELLED", async () => {
  const f = fixture({ pollMs: 10 });
  // Real clock here: the fake clock never advances, and periodic reaping
  // after the timeout is exactly what this test exercises.
  const orch = new Orchestrator(f.db, f.app, f.runner, { pollMs: 10, taskTimeoutMs: 300 });
  try {
    const project = f.app.projects.create({ name: `p-${Math.random().toString(36).slice(2)}`, repoPath: join(f.base, "repo"), worktreeRoot: join(f.base, "wt"), verifyCommand: [process.execPath, "-e", "setTimeout(() => {}, 60000)"] });
    const { task } = f.app.tasks.create(project.id, "slow verify");
    await f.app.worktrees.prepare(task.id);
    f.app.workflows.start({ taskId: task.id, preset: "fast" });
    f.orchestrator.queue.enqueue(task.id);
    await orch.start();
    const deadline = Date.now() + 10_000;
    let state = "";
    while (Date.now() < deadline) {
      state = f.app.tasks.list().find((t) => t.id === task.id)!.state;
      if (state === "FAILED" || state === "CANCELLED") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(state, "FAILED", "a timed-out task is FAILED (retryable by the fix loop), never masquerades as a user cancel");
    const events = f.db.prepare("SELECT type FROM outbox_events WHERE task_id = ?").all(task.id) as { type: string }[];
    assert.ok(events.some((e) => e.type === "task.timeout"), `timeout event published: ${JSON.stringify(events)}`);
  } finally { await orch.stop(); f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("claimInlineRun enforces the scheduling gate and active-run validation", async () => {
  const f = fixture();
  try {
    const taskId = await queuedTask(f);
    const runId = f.orchestrator.queue.activeRunId(taskId)!;
    const projectId = f.app.tasks.list().find((t) => t.id === taskId)!.projectId;
    // PAUSED project: refused before touching lease or queue.
    f.app.projects.setStatus(projectId, "PAUSED");
    assert.throws(() => f.orchestrator.claimInlineRun(taskId, runId, "cli-test", 60_000), /PAUSED/);
    assert.equal(f.orchestrator.queue.size(), 1, "queue entry survives a refused claim");
    f.app.projects.setStatus(projectId, "ACTIVE");
    // Stale run-id: refused, entry survives, lease released.
    assert.throws(() => f.orchestrator.claimInlineRun(taskId, "00000000-0000-0000-0000-000000000000", "cli-test", 60_000), /not the task's active run/);
    assert.equal(f.orchestrator.queue.size(), 1);
    // Happy path: lease held, entry consumed, heartbeat works, release clean.
    const claim = f.orchestrator.claimInlineRun(taskId, runId, "cli-test", 60_000);
    assert.equal(f.orchestrator.queue.size(), 0, "claim consumes the pending signal");
    assert.equal(claim.heartbeat(), "ok");
    claim.release();
    assert.equal(claim.heartbeat(), "lost", "released lease cannot heartbeat");
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("recoverOrphans fails RUNNING tasks with dead leases and cancels their runs", async () => {
  const f = fixture();
  try {
    const taskId = await queuedTask(f);
    // Simulate a crashed worker mid-step: the queue entry was consumed at
    // claim time, and the dead worker left an expired lease row behind (a
    // clean release deletes the row).
    f.orchestrator.queue.dequeue(taskId);
    f.app.repositories.tasks.update(taskId, { state: "RUNNING" }, f.clock.now().toISOString());
    const runId = (f.db.prepare(`SELECT id FROM workflow_runs WHERE task_revision_id IN (SELECT id FROM task_revisions WHERE task_id = ?)`).all(taskId) as { id: string }[])[0]!.id;
    f.db.prepare("UPDATE workflow_runs SET state = 'RUNNING' WHERE id = ?").run(runId);
    f.db.prepare("INSERT INTO worker_leases (lease_key, owner, task_id, acquired_at, expires_at) VALUES (?,?,?,?,?)")
      .run(`task:${taskId}`, "dead-worker", taskId, f.clock.now().toISOString(), new Date(f.clock.now().getTime() - 1_000).toISOString());
    const recovered = f.orchestrator.recoverOrphans();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]!.taskId, taskId);
    assert.equal(f.app.tasks.list().find((t) => t.id === taskId)!.state, "FAILED");
    assert.equal(f.app.workflows.status(runId).run.state, "CANCELLED");
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("recoverIfOrphaned never downgrades a completed task, even with no lease or queue entry", async () => {
  const f = fixture();
  try {
    const taskId = await queuedTask(f);
    await f.orchestrator.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await f.orchestrator.stop();
    // Terminal state, no lease, no queue entry — the exact end state of the
    // "candidate selected, then the run finished" race. The in-transaction
    // predicate must refuse to classify it as an orphan.
    assert.equal(f.app.tasks.list().find((t) => t.id === taskId)!.state, "SUCCEEDED");
    assert.equal(f.orchestrator.recoverIfOrphaned(taskId), null);
    assert.equal(f.app.tasks.list().find((t) => t.id === taskId)!.state, "SUCCEEDED");
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("recoverOrphans settles a CANCEL_REQUESTED task with a dead worker to CANCELLED", async () => {
  const f = fixture();
  try {
    const taskId = await queuedTask(f);
    // The worker crashed after requestCancel: queue entry consumed at claim,
    // task CANCEL_REQUESTED, run still RUNNING, expired lease row left behind.
    f.orchestrator.queue.dequeue(taskId);
    f.app.repositories.tasks.update(taskId, { state: "CANCEL_REQUESTED" }, f.clock.now().toISOString());
    const runId = (f.db.prepare(`SELECT id FROM workflow_runs WHERE task_revision_id IN (SELECT id FROM task_revisions WHERE task_id = ?)`).all(taskId) as { id: string }[])[0]!.id;
    f.db.prepare("UPDATE workflow_runs SET state = 'RUNNING' WHERE id = ?").run(runId);
    f.db.prepare("INSERT INTO worker_leases (lease_key, owner, task_id, acquired_at, expires_at) VALUES (?,?,?,?,?)")
      .run(`task:${taskId}`, "dead-worker", taskId, f.clock.now().toISOString(), new Date(f.clock.now().getTime() - 1_000).toISOString());
    const recovered = f.orchestrator.recoverOrphans();
    assert.equal(recovered.length, 1);
    assert.equal(f.app.tasks.list().find((t) => t.id === taskId)!.state, "CANCELLED", "user-requested cancel settles CANCELLED, not FAILED");
    assert.equal(f.app.workflows.status(runId).run.state, "CANCELLED");
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("recoverOrphans leaves leased tasks alone", async () => {
  const f = fixture();
  try {
    const taskId = await queuedTask(f);
    f.app.repositories.tasks.update(taskId, { state: "RUNNING" }, f.clock.now().toISOString());
    // A live lease from another worker.
    f.db.prepare("INSERT INTO worker_leases (lease_key, owner, task_id, acquired_at, expires_at) VALUES (?,?,?,?,?)").run(`task:${taskId}`, "other-worker", taskId, f.clock.now().toISOString(), new Date(f.clock.now().getTime() + 60_000).toISOString());
    assert.equal(f.orchestrator.recoverOrphans().length, 0);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("requestCancel marks CANCEL_REQUESTED and emits an event", async () => {
  const f = fixture();
  try {
    const taskId = await queuedTask(f);
    f.app.repositories.tasks.update(taskId, { state: "RUNNING" }, f.clock.now().toISOString());
    f.orchestrator.requestCancel(taskId);
    assert.equal(f.app.tasks.list().find((t) => t.id === taskId)!.state, "CANCEL_REQUESTED");
    const events = f.db.prepare("SELECT type FROM outbox_events WHERE task_id = ?").all(taskId) as { type: string }[];
    assert.ok(events.some((e) => e.type === "task.cancel-requested"));
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("cancelOwner kills only the target task's processes", async () => {
  const runner = new ProcessRunner();
  const slow = (owner: string) => runner.run({ cwd: process.cwd(), argv: [process.execPath, "-e", "setTimeout(() => {}, 30000)"], env: { PATH: process.env.PATH! }, timeoutMs: 60_000, owner });
  const taskA = slow("task-a");
  const taskB = slow("task-b");
  await new Promise((resolve) => setTimeout(resolve, 100));
  runner.cancelOwner("task-a");
  await assert.rejects(taskA, /cancelled/);
  // task-b must still be running; cancel and confirm it was alive until its own cancel.
  runner.cancelOwner("task-b");
  await assert.rejects(taskB, /cancelled/);
});

test("once() releases the dedup key when the action fails, allowing retry", async () => {
  const f = fixture();
  try {
    let attempts = 0;
    const failing = async () => { attempts++; if (attempts === 1) throw new Error("transient"); };
    await assert.rejects(f.orchestrator.once("cmd-retry", failing), /transient/);
    assert.equal(await f.orchestrator.once("cmd-retry", failing), true, "retry after failure succeeds");
    assert.equal(attempts, 2);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});
