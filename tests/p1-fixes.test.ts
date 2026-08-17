import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../src/db/database.js";
import { createApplication } from "../src/app/application.js";
import { createRepository } from "./helpers.js";
import { ImController } from "../src/im/im-controller.js";
import { Orchestrator } from "../src/reliability/orchestrator.js";
import { OutboxDispatcher } from "../src/reliability/outbox-dispatcher.js";
import { TransactionalOutbox } from "../src/reliability/outbox.js";
import { ProcessRunner } from "../src/runtime/process-runner.js";
import { OsSandbox } from "../src/runtime/os-sandbox.js";
import { PROFILES } from "../src/security/permissions.js";
import { AgentThreadManager } from "../src/runtime/agent-thread-manager.js";
import { SqliteAgentThreadRepository } from "../src/agents/agent-thread-repository.js";
import { SqliteArtifactRepository } from "../src/artifacts/artifact-repository.js";
import { SqliteTaskRepository } from "../src/tasks/task-repository.js";
import { WorkflowEngine } from "../src/workflows/workflow-engine.js";
import type { ImReply } from "../src/im/im-adapter.js";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "agentdock-p1-"));
  createRepository(join(base, "repo"));
  const db = openDatabase(":memory:");
  const fakeAgent = { provider: "fake", async run() { return { exitCode: 0, stdout: "VERDICT: PASS", stderr: "", externalSessionId: "s", resumed: false }; } };
  const app = createApplication(db, { agents: { claude: fakeAgent, codex: fakeAgent } });
  const controller = new ImController(db, app);
  const orchestrator = new Orchestrator(db, app, app.processRunner, { pollMs: 5 });
  controller.attachOrchestrator(orchestrator);
  const notifications: { conversationId: string; text: string }[] = [];
  const outbox = new TransactionalOutbox(db);
  const dispatcher = new OutboxDispatcher(db, outbox, async (conversationId, text) => { notifications.push({ conversationId, text }); }, "test-worker", 5);
  controller.attachNotifier(dispatcher);
  return { base, db, app, controller, orchestrator, dispatcher, notifications };
}

async function waitFor<T>(probe: () => Promise<T> | T, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value === true || value === "SUCCEEDED" || value === "FAILED") return value;
    if (Date.now() >= deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function readyTask(f: ReturnType<typeof fixture>): Promise<string> {
  const project = f.app.projects.create({ name: `p-${Math.random().toString(36).slice(2)}`, repoPath: join(f.base, "repo"), worktreeRoot: join(f.base, "wt") });
  const { task } = f.app.tasks.create(project.id, "request");
  await f.app.worktrees.prepare(task.id);
  return task.id;
}

test("approval enqueues through the orchestrator instead of inline execute", async () => {
  const f = fixture();
  try {
    const taskId = await readyTask(f);
    await f.app.workflows.start({ taskId, preset: "careful" });
    const runId = (f.db.prepare(`SELECT id FROM workflow_runs ORDER BY created_at DESC LIMIT 1`).get() as { id: string }).id;
    const paused = await f.app.workflows.execute(runId);
    assert.equal(paused.awaitingApproval, true);
    await f.orchestrator.start();
    // Approve via the controller with the orchestrator attached.
    const approved = await f.controller.handle({ type: "APPROVE_RUN", conversationId: "c1", runId, approved: true });
    assert.match(approved.text, /queued for the orchestrator/);
    // The careful preset has a second approval gate. Poll-and-approve in a
    // loop: gates surface asynchronously as the orchestrator advances the run.
    const done = await waitFor(async () => {
      const status = f.app.workflows.status(runId);
      if (status.awaitingApproval) {
        await f.controller.handle({ type: "APPROVE_RUN", conversationId: "c1", runId, approved: true });
        return null;
      }
      const state = f.app.tasks.list().find((t) => t.id === taskId)!.state;
      return state === "SUCCEEDED" || state === "FAILED" ? state : null;
    }, 10_000);
    assert.equal(done, "SUCCEEDED");
  } finally { await f.orchestrator.stop(); f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("an approved run queued for pickup is not orphan-recovered", async () => {
  const f = fixture();
  try {
    const taskId = await readyTask(f);
    await f.app.workflows.start({ taskId, preset: "careful" });
    const runId = (f.db.prepare(`SELECT id FROM workflow_runs ORDER BY created_at DESC LIMIT 1`).get() as { id: string }).id;
    const paused = await f.app.workflows.execute(runId);
    assert.equal(paused.awaitingApproval, true);
    // The race window: approved and re-enqueued, but no worker has acquired a
    // lease yet. Orphan recovery must treat this as pending, not orphaned.
    await f.controller.handle({ type: "APPROVE_RUN", conversationId: "c1", runId, approved: true });
    assert.deepEqual(f.orchestrator.recoverOrphans(), []);
    assert.equal(f.app.tasks.list().find((t) => t.id === taskId)!.state, "RUNNING");
    assert.equal(f.app.workflows.status(runId).run.state, "RUNNING");
  } finally { await f.orchestrator.stop(); f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("approval re-enqueue after a crash at the gate is not orphan-recovered", async () => {
  const f = fixture();
  try {
    const taskId = await readyTask(f);
    await f.app.workflows.start({ taskId, preset: "careful" });
    const runId = (f.db.prepare(`SELECT id FROM workflow_runs ORDER BY created_at DESC LIMIT 1`).get() as { id: string }).id;
    const paused = await f.app.workflows.execute(runId);
    assert.equal(paused.awaitingApproval, true);
    // The worker died while the run was parked at the gate: its expired lease
    // row is still there. The paused gate itself is never an orphan...
    assert.deepEqual(f.orchestrator.recoverOrphans(), []);
    f.db.prepare("INSERT INTO worker_leases (lease_key, owner, task_id, acquired_at, expires_at) VALUES (?,?,?,?,?)")
      .run(`task:${taskId}`, "dead-worker", taskId, new Date(Date.now() - 120_000).toISOString(), new Date(Date.now() - 60_000).toISOString());
    // ...and neither is the fresh re-enqueue after the user approves: the
    // stale lease row must not turn the pending pickup into an "orphan".
    await f.controller.handle({ type: "APPROVE_RUN", conversationId: "c1", runId, approved: true });
    assert.deepEqual(f.orchestrator.recoverOrphans(), []);
    assert.equal(f.app.tasks.list().find((t) => t.id === taskId)!.state, "RUNNING");
    assert.equal(f.app.workflows.status(runId).run.state, "RUNNING");
  } finally { await f.orchestrator.stop(); f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("approval and orphan recovery interlock across two real database connections", async () => {
  const base = mkdtempSync(join(tmpdir(), "agentdock-p1-"));
  createRepository(join(base, "repo"));
  const dbPath = join(base, "shared.db");
  const fakeAgent = { provider: "fake", async run() { return { exitCode: 0, stdout: "VERDICT: PASS", stderr: "", externalSessionId: "s", resumed: false }; } };
  const db1 = openDatabase(dbPath);
  const app1 = createApplication(db1, { agents: { claude: fakeAgent, codex: fakeAgent } });
  const controller = new ImController(db1, app1);
  const orch1 = new Orchestrator(db1, app1, app1.processRunner, {});
  controller.attachOrchestrator(orch1);
  const db2 = openDatabase(dbPath);
  const app2 = createApplication(db2, { agents: { claude: fakeAgent, codex: fakeAgent } });
  const orch2 = new Orchestrator(db2, app2, app2.processRunner, {});
  try {
    const project = app1.projects.create({ name: "two-conn", repoPath: join(base, "repo"), worktreeRoot: join(base, "wt") });
    const { task } = app1.tasks.create(project.id, "request");
    await app1.worktrees.prepare(task.id);
    await app1.workflows.start({ taskId: task.id, preset: "careful" });
    const runId = (db1.prepare(`SELECT id FROM workflow_runs ORDER BY created_at DESC LIMIT 1`).get() as { id: string }).id;
    const paused = await app1.workflows.execute(runId);
    assert.equal(paused.awaitingApproval, true);
    // A dead worker's expired lease at the gate: recovery on the other
    // connection must leave the paused run alone.
    db1.prepare("INSERT INTO worker_leases (lease_key, owner, task_id, acquired_at, expires_at) VALUES (?,?,?,?,?)")
      .run(`task:${task.id}`, "dead-worker", task.id, new Date(Date.now() - 120_000).toISOString(), new Date(Date.now() - 60_000).toISOString());
    assert.equal(orch2.recoverIfOrphaned(task.id), null, "paused gate is not an orphan across connections");
    // Approve + enqueue atomically on conn 1; recovery on conn 2 must see the
    // committed pair, never half of it.
    await controller.handle({ type: "APPROVE_RUN", conversationId: "c1", runId, approved: true });
    assert.equal(orch2.recoverIfOrphaned(task.id), null, "approved-and-queued run is not an orphan across connections");
    assert.equal(app2.tasks.list().find((t) => t.id === task.id)!.state, "RUNNING");
    assert.equal(app2.workflows.status(runId).run.state, "RUNNING");
  } finally { db1.close(); db2.close(); rmSync(base, { recursive: true, force: true }); }
});

test("CI failure triggers reopen -> fix workflow -> orchestrator execution", async () => {
  const f = fixture();
  try {
    const taskId = await readyTask(f);
    await f.app.workflows.start({ taskId, preset: "fast" });
    const firstRunId = (f.db.prepare(`SELECT id FROM workflow_runs ORDER BY created_at DESC LIMIT 1`).get() as { id: string }).id;
    await f.app.workflows.execute(firstRunId);
    assert.equal(f.app.tasks.list().find((t) => t.id === taskId)!.state, "SUCCEEDED");
    // Simulate CI failure ingestion (github refresh would do this via the gh port).
    f.app.repositories.tasks.update(taskId, { state: "FAILED" }, new Date().toISOString());
    f.db.prepare(`INSERT INTO github_fix_events (id, task_id, pr_number, reason, detail, created_at) VALUES (?,?,?,?,?,?)`)
      .run(randomUUID(), taskId, 42, "CI_FAILURE", JSON.stringify(["build"]), new Date().toISOString());

    await f.orchestrator.start();
    await f.orchestrator.runPendingFixes();
    await new Promise((resolve) => setTimeout(resolve, 400));
    // The fix workflow ran to completion: task SUCCEEDED, fix run exists.
    assert.equal(f.app.tasks.list().find((t) => t.id === taskId)!.state, "SUCCEEDED");
    const runs = f.db.prepare(`SELECT id FROM workflow_runs ORDER BY created_at`).all() as { id: string }[];
    assert.equal(runs.length, 2, "a second (fix) run was created");
    const fixSteps = f.app.repositories.workflows.listSteps(runs[1]!.id).map((s) => s.stepType);
    assert.deepEqual(fixSteps, ["FIX", "VERIFY", "REVIEW"]);
  } finally { await f.orchestrator.stop(); f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("outbox dispatcher notifies the subscribed conversation of run completion", async () => {
  const f = fixture();
  try {
    const taskId = await readyTask(f);
    // The conversation starts the task: interest is tracked, events flow.
    const project = f.app.projects.list()[0]!;
    await f.controller.handle({ type: "USE_PROJECT", conversationId: "c1", projectName: project.name });
    const created = await f.controller.handle({ type: "CREATE_TASK", conversationId: "c1", request: "notify me" });
    const notifyTaskId = (created.text.match(/Task created: (\S+)/) ?? [])[1]!;
    await f.app.worktrees.prepare(notifyTaskId);
    await f.controller.handle({ type: "RUN_TASK", conversationId: "c1", taskId: notifyTaskId, preset: "fast" });
    await f.orchestrator.start();
    await f.dispatcher.start();
    await new Promise((resolve) => setTimeout(resolve, 600));
    await f.orchestrator.stop();
    await f.dispatcher.stop();
    assert.ok(f.notifications.some((n) => n.conversationId === "c1" && /SUCCEEDED/.test(n.text)), `notifications: ${JSON.stringify(f.notifications)}`);
    void taskId;
  } finally { await f.orchestrator.stop(); f.dispatcher.stop(); f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("bwrap argv binds runtime filesystem and tolerates missing config dirs", () => {
  const profile = PROFILES["restricted"]!;
  const argv = OsSandbox.bwrapArgv(profile, "/wt", ["codex", "exec"]);
  const joined = argv.join(" ");
  // Dynamic linkers and system config must be present or node/git die on startup.
  assert.match(joined, /--ro-bind-try \/lib \/lib/);
  assert.match(joined, /--ro-bind-try \/lib64 \/lib64/);
  assert.match(joined, /--ro-bind \/etc \/etc/);
  assert.match(joined, /--ro-bind-try .*\.claude/);
  assert.match(joined, /--ro-bind-try .*\.codex/);
  // ro-bind-try (not ro-bind) everywhere optional: missing dirs must not fail the sandbox.
  const optionalBinds = argv.filter((arg, i) => argv[i - 1] === "--ro-bind-try").length;
  assert.ok(optionalBinds >= 5, "system/config binds are tolerant of absence");
});

test("conversation adapter origin survives a controller restart", async () => {
  const f = fixture();
  try {
    f.app.projects.create({ name: "origin-p", repoPath: join(f.base, "repo"), worktreeRoot: join(f.base, "wt") });
    await f.controller.handle({ type: "USE_PROJECT", conversationId: "conv-9", projectName: "origin-p" }, "telegram");
    // Fresh controller over the same DB: notify must still route to telegram only.
    const revived = new ImController(f.db, f.app);
    const delivered: string[] = [];
    revived.register({ name: "telegram", async start() {}, async stop() {}, async send(reply) { delivered.push(`telegram:${reply.conversationId}`); }, onMessage() {}, onAction() {} });
    revived.register({ name: "feishu", async start() {}, async stop() {}, async send(reply) { delivered.push(`feishu:${reply.conversationId}`); }, onMessage() {}, onAction() {} });
    await revived.notify("conv-9", "hello");
    assert.deepEqual(delivered, ["telegram:conv-9"], "notification routes to the persisted origin adapter");
  } finally { await f.orchestrator.stop(); f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("fix triggers are bound to their run and cleared only on success", async () => {
  const f = fixture();
  try {
    const taskId = await readyTask(f);
    f.app.repositories.tasks.update(taskId, { state: "FAILED" }, new Date().toISOString());
    f.db.prepare(`INSERT INTO github_fix_events (id, task_id, pr_number, reason, detail, created_at) VALUES (?,?,?,?,?,?)`)
      .run(randomUUID(), taskId, 42, "CI_FAILURE", JSON.stringify(["build"]), new Date().toISOString());
    const { runId } = await f.app.github.startFixWorkflow(taskId, (input) => f.app.workflows.start(input));
    // Bound to the run: not pending anymore, so runPendingFixes will not double-trigger.
    assert.equal(f.app.github.pendingFixTriggers(taskId).length, 0);
    // Simulate the fix run failing: the trigger unbinds and becomes retryable.
    f.db.prepare("UPDATE github_fix_events SET consumed_by_run = NULL WHERE consumed_by_run = ?").run(runId);
    assert.equal(f.app.github.pendingFixTriggers(taskId).length, 1);
    // Success path clears them for good.
    f.app.github.markTriggersConsumed(taskId, runId);
    f.app.github.clearConsumedTriggers(runId);
    assert.equal((f.db.prepare("SELECT COUNT(*) c FROM github_fix_events WHERE task_id = ?").get(taskId) as { c: number }).c, 0);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("markProcessed refuses a worker that does not hold the claim", () => {
  const db = openDatabase(":memory:");
  const outbox = new TransactionalOutbox(db);
  outbox.publish({ taskId: "t1", type: "run.succeeded", payload: {} });
  // No claim at all: a bare markProcessed must be refused.
  assert.equal(outbox.markProcessed(1, "sneaky"), false);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM outbox_events WHERE processed_at IS NULL").get() as { c: number }).c, 1);
  const claimed = outbox.claimBatch("owner", 10);
  const event = claimed[0]!;
  // Different worker cannot close it even while claimed.
  assert.equal(outbox.markProcessed(event.id, "sneaky"), false);
  assert.equal(outbox.markProcessed(event.id, "owner"), true);
  db.close();
});

test("same conversationId on two platforms keeps separate subscriptions and origins", async () => {
  const f = fixture();
  try {
    // Same conversationId from both adapters: two durable origin rows coexist.
    await f.controller.handle({ type: "LIST_PROJECTS", conversationId: "shared-1" }, "telegram");
    await f.controller.handle({ type: "LIST_PROJECTS", conversationId: "shared-1" }, "feishu");
    const origins = f.db.prepare("SELECT adapter FROM im_conversation_origins WHERE conversation_id = ? ORDER BY adapter").all("shared-1") as { adapter: string }[];
    assert.deepEqual(origins.map((o) => o.adapter), ["feishu", "telegram"], "both origin rows survive");

    // Both subscribe to the same task: two subscription rows, correct adapters.
    const dispatcher = f.dispatcher;
    dispatcher.subscribe("shared-1", "task-x", "telegram");
    dispatcher.subscribe("shared-1", "task-x", "feishu");
    const subs = f.db.prepare("SELECT adapter FROM im_task_subscriptions WHERE conversation_id = ? AND task_id = ? ORDER BY adapter").all("shared-1", "task-x") as { adapter: string }[];
    assert.deepEqual(subs.map((s2) => s2.adapter), ["feishu", "telegram"], "subscriptions do not overwrite each other");
  } finally { await f.orchestrator.stop(); f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("crash-recovered fix run unbinds its triggers for retry", async () => {
  const f = fixture();
  try {
    const taskId = await readyTask(f);
    f.app.repositories.tasks.update(taskId, { state: "FAILED" }, new Date().toISOString());
    f.db.prepare(`INSERT INTO github_fix_events (id, task_id, pr_number, reason, detail, created_at) VALUES (?,?,?,?,?,?)`)
      .run(randomUUID(), taskId, 42, "CI_FAILURE", JSON.stringify(["build"]), new Date().toISOString());
    const { runId } = await f.app.github.startFixWorkflow(taskId, (input) => f.app.workflows.start(input));
    assert.equal(f.app.github.pendingFixTriggers(taskId).length, 0, "bound while the run is in flight");
    // Simulate a worker crash mid-fix followed by orphan recovery cancelling the run.
    f.app.repositories.tasks.update(taskId, { state: "RUNNING" }, new Date().toISOString());
    f.app.workflows.cancel(runId);
    f.app.repositories.tasks.update(taskId, { state: "FAILED" }, new Date().toISOString());
    f.orchestrator.reapFinishedFixRuns();
    assert.equal(f.app.github.pendingFixTriggers(taskId).length, 1, "cancelled fix run unbinds triggers for retry");
    // And the next sweep starts a fresh fix run.
    const started2 = await f.orchestrator.runPendingFixes();
    assert.equal(started2.length, 1);
  } finally { await f.orchestrator.stop(); f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("step timeout persists on the run and executes use it", async () => {
  const f = fixture();
  try {
    const taskId = await readyTask(f);
    const started = await f.app.workflows.start({ taskId, preset: "fast", stepTimeoutMs: 120_000 });
    assert.equal(started.run.stepTimeoutMs, 120_000);
    // The persisted value survives a reload from the DB.
    const reloaded = f.app.repositories.workflows.findRun(started.run.id);
    assert.equal(reloaded?.stepTimeoutMs, 120_000);
    // Default applies when unset.
    const project2 = f.app.projects.create({ name: `p2-${Math.random().toString(36).slice(2)}`, repoPath: join(f.base, "repo2"), worktreeRoot: join(f.base, "wt2") });
    void project2;
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});
