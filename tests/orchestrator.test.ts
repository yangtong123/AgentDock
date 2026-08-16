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
}

function fixture(options: { pollMs?: number } = {}): Fixture {
  const base = mkdtempSync(join(tmpdir(), "agentdock-orch-"));
  createRepository(join(base, "repo"));
  const db = openDatabase(":memory:");
  const app = createApplication(db);
  const clock = fakeClock(Date.UTC(2026, 0, 1));
  // Fake agents so no real CLI runs.
  const fakeAgent = { provider: "fake", async run() { return { exitCode: 0, stdout: "VERDICT: PASS", stderr: "", externalSessionId: "s", resumed: false }; } };
  const runtime = new AgentThreadManager(new SqliteAgentThreadRepository(db), new SqliteArtifactRepository(db), new SqliteTaskRepository(db), () => fakeAgent, join(base, "artifacts"));
  // Swap in the fake runtime by rebuilding the engine with it.
  const fakeEngine = new WorkflowEngine(app.repositories.workflows, app.repositories.tasks, app.repositories.projects, runtime, new SqliteArtifactRepository(db), new ProcessRunner(), process.env, () => clock.now().toISOString());
  (app as unknown as Record<string, unknown>).workflows = fakeEngine;
  const orchestrator = new Orchestrator(db, app, new ProcessRunner(), { pollMs: options.pollMs ?? 10 }, clock);
  return { base, db, app, orchestrator, clock, runtime };
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

test("orchestrator.once executes an action exactly once", async () => {
  const f = fixture();
  try {
    let executions = 0;
    const action = async () => { executions++; };
    assert.equal(await f.orchestrator.once("approve:r1", action), true);
    assert.equal(await f.orchestrator.once("approve:r1", action), false);
    assert.equal(executions, 1);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("recoverOrphans fails RUNNING tasks with dead leases and cancels their runs", async () => {
  const f = fixture();
  try {
    const taskId = await queuedTask(f);
    // Simulate a crashed worker: task RUNNING, run RUNNING, no lease.
    f.app.repositories.tasks.update(taskId, { state: "RUNNING" }, f.clock.now().toISOString());
    const runId = (f.db.prepare(`SELECT id FROM workflow_runs WHERE task_revision_id IN (SELECT id FROM task_revisions WHERE task_id = ?)`).all(taskId) as { id: string }[])[0]!.id;
    f.db.prepare("UPDATE workflow_runs SET state = 'RUNNING' WHERE id = ?").run(runId);
    const recovered = f.orchestrator.recoverOrphans();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]!.taskId, taskId);
    assert.equal(f.app.tasks.list().find((t) => t.id === taskId)!.state, "FAILED");
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
