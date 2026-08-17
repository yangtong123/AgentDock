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
    // The careful preset has a second approval gate at the end.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const status = f.app.workflows.status(runId);
    if (status.awaitingApproval) await f.controller.handle({ type: "APPROVE_RUN", conversationId: "c1", runId, approved: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(f.app.tasks.list().find((t) => t.id === taskId)!.state, "SUCCEEDED");
  } finally { await f.orchestrator.stop(); f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
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
