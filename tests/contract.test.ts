import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db/database.js";
import { createApplication } from "../src/app/application.js";
import { createRepository } from "./helpers.js";
import { ImController } from "../src/im/im-controller.js";
import { parseCommand } from "../src/im/command-parser.js";
import { Orchestrator } from "../src/reliability/orchestrator.js";
import { OutboxDispatcher } from "../src/reliability/outbox-dispatcher.js";
import { TransactionalOutbox } from "../src/reliability/outbox.js";
import { TaskQueue } from "../src/reliability/task-queue.js";
import { StateConflictError, type TaskDetails } from "../src/shared/domain.js";
import type { WorkflowStatus } from "../src/workflows/workflow-engine.js";
import { approveRun, cancelRun, createTask, reviseTask, startRun, type CommandContext } from "../src/commands/task-commands.js";

function fixture(options: { withOrchestrator?: boolean } = {}) {
  const base = mkdtempSync(join(tmpdir(), "agentdock-contract-"));
  createRepository(join(base, "repo"));
  const db = openDatabase(":memory:");
  const fakeAgent = { provider: "fake", async run() { return { exitCode: 0, stdout: "VERDICT: PASS", stderr: "", externalSessionId: "s", resumed: false }; } };
  const app = createApplication(db, { agents: { claude: fakeAgent, codex: fakeAgent } });
  const controller = new ImController(db, app);
  const orchestrator = options.withOrchestrator === true ? new Orchestrator(db, app, app.processRunner, { pollMs: 5, activity: app.activity }) : null;
  if (orchestrator !== null) controller.attachOrchestrator(orchestrator);
  const notifications: { conversationId: string; text: string; adapter: string | null }[] = [];
  const dispatcher = new OutboxDispatcher(db, new TransactionalOutbox(db), async (conversationId, text, adapter) => { notifications.push({ conversationId, text, adapter }); }, "test-worker", 5);
  controller.attachNotifier(dispatcher);
  const commands: CommandContext = { db, app, queue: orchestrator?.queue ?? new TaskQueue(db), outbox: new TransactionalOutbox(db), activity: app.activity, audit: app.audit };
  const cleanup = async () => { await orchestrator?.stop(); await dispatcher.stop(); db.close(); rmSync(base, { recursive: true, force: true }); };
  return { base, db, app, controller, orchestrator, dispatcher, notifications, commands, cleanup };
}

function project(f: ReturnType<typeof fixture>): string {
  return f.app.projects.create({ name: `p-${Math.random().toString(36).slice(2)}`, repoPath: join(f.base, "repo"), worktreeRoot: join(f.base, "wt") }).id;
}

test("parser: /run with provider assignments and /providers", () => {
  assert.deepEqual(
    parseCommand("c1", "/run abc123 cross-review IMPLEMENT=claude REVIEW=codex FIX=claude FINAL_REVIEW=codex"),
    { type: "RUN_TASK", conversationId: "c1", taskId: "abc123", preset: "cross-review", providers: { IMPLEMENT: "claude", REVIEW: "codex", FIX: "claude", FINAL_REVIEW: "codex" } },
  );
  assert.deepEqual(parseCommand("c1", "/run abc123 fast"), { type: "RUN_TASK", conversationId: "c1", taskId: "abc123", preset: "fast" });
  assert.deepEqual(parseCommand("c1", "/run abc123 fix"), { type: "RUN_TASK", conversationId: "c1", taskId: "abc123", preset: "fix" });
  // Unknown preset, unknown step type, malformed token: all rejected.
  assert.equal(parseCommand("c1", "/run abc123 bogus"), null);
  assert.equal(parseCommand("c1", "/run abc123 fast DEPLOY=claude"), null);
  assert.equal(parseCommand("c1", "/run abc123 fast IMPLEMENT"), null);
  assert.equal(parseCommand("c1", "/run abc123 fast IMPLEMENT="), null);
  assert.deepEqual(parseCommand("c1", "/providers"), { type: "LIST_PROVIDERS", conversationId: "c1" });
});

test("IM /run applies provider assignments; invalid provider yields a helpful error", async () => {
  const f = fixture();
  try {
    const projectId = project(f);
    await f.controller.handle({ type: "USE_PROJECT", conversationId: "c1", projectName: f.app.projects.list()[0]!.name }, "telegram");
    const created = await f.controller.handle({ type: "CREATE_TASK", conversationId: "c1", request: "assign providers" }, "telegram");
    const taskId = /Task created: (\S+)/.exec(created.text)![1]!;

    const bad = await f.controller.handle({ type: "RUN_TASK", conversationId: "c1", taskId, preset: "cross-review", providers: { IMPLEMENT: "gpt-x" } }, "telegram");
    assert.match(bad.text, /unknown provider gpt-x/);
    assert.match(bad.text, /known: claude, codex/, "error lists valid providers");

    const reply = await f.controller.handle({ type: "RUN_TASK", conversationId: "c1", taskId, preset: "cross-review", providers: { IMPLEMENT: "codex", REVIEW: "claude" } }, "telegram");
    assert.match(reply.text, /finished: SUCCEEDED/);
    const run = f.db.prepare("SELECT wr.id FROM workflow_runs wr JOIN task_revisions tr ON wr.task_revision_id = tr.id WHERE tr.task_id = ?").get(taskId) as { id: string };
    const steps = f.app.workflows.status(run.id).steps;
    assert.equal(steps.find((s) => s.stepType === "IMPLEMENT")!.provider, "codex");
    assert.equal(steps.find((s) => s.stepType === "REVIEW")!.provider, "claude");
    void projectId;
  } finally { await f.cleanup(); }
});

test("/providers lists providers and defaults", async () => {
  const f = fixture();
  try {
    const reply = await f.controller.handle({ type: "LIST_PROVIDERS", conversationId: "c1" }, "telegram");
    assert.match(reply.text, /Providers: claude, codex/);
    assert.match(reply.text, /IMPLEMENT=claude/);
    assert.match(reply.text, /REVIEW=codex/);
  } finally { await f.cleanup(); }
});

test("actor contract: IM commands audit/record the adapter name, conversation id in detail", async () => {
  const f = fixture();
  try {
    project(f);
    await f.controller.handle({ type: "USE_PROJECT", conversationId: "c1", projectName: f.app.projects.list()[0]!.name }, "telegram");
    const created = await f.controller.handle({ type: "CREATE_TASK", conversationId: "c1", request: "actor check" }, "telegram");
    const taskId = /Task created: (\S+)/.exec(created.text)![1]!;
    const taskAudit = f.app.audit.list({ taskId });
    assert.ok(taskAudit.every((entry) => entry.actor === "telegram"), `audit actor is the surface, got ${JSON.stringify(taskAudit.map((a) => a.actor))}`);
    assert.ok(taskAudit.some((entry) => entry.action === "task.create"));
    // Controller-level audit rows key on the command (task id unknown at CREATE time).
    const all = f.app.audit.list({});
    const controllerEntry = all.find((entry) => entry.action === "CREATE_TASK")!;
    assert.equal(controllerEntry.actor, "telegram");
    assert.equal((JSON.parse(controllerEntry.detail) as { conversationId: string }).conversationId, "c1", "conversation id travels in audit detail");
    const activity = f.app.activity.listForTask(taskId, 10);
    const createdEvent = activity.find((event) => event.type === "task.created")!;
    assert.equal(createdEvent.actor, "telegram");
  } finally { await f.cleanup(); }
});

test("IM reject goes through the command handler (audit + approval.decided activity)", async () => {
  const f = fixture();
  try {
    const projectId = project(f);
    const { task } = f.app.tasks.create(projectId, "reject me");
    await f.app.worktrees.prepare(task.id);
    const started = f.app.workflows.start({ taskId: task.id, preset: "careful" });
    const parked = await f.app.workflows.execute(started.run.id);
    assert.equal(parked.awaitingApproval, true);
    const reply = await f.controller.handle({ type: "APPROVE_RUN", conversationId: "c1", runId: started.run.id, approved: false }, "feishu");
    assert.match(reply.text, /Rejected/);
    assert.match(reply.text, new RegExp(started.run.id));
    assert.equal(f.app.workflows.status(started.run.id).run.state, "CANCELLED");
    assert.ok(f.app.audit.list({ taskId: task.id }).some((entry) => entry.action === "run.reject" && entry.actor === "feishu"));
    const decided = f.app.activity.listForTask(task.id, 50).filter((event) => event.type === "approval.decided");
    assert.equal(decided.length, 1);
    assert.equal(decided[0]!.actor, "feishu");
  } finally { await f.cleanup(); }
});

test("approval gate notifies each subscribed conversation on its own adapter", async () => {
  const f = fixture({ withOrchestrator: true });
  try {
    const projectId = project(f);
    const projectName = f.app.projects.list()[0]!.name;
    // Both platforms subscribe to the same task (same conversation id on purpose).
    await f.controller.handle({ type: "USE_PROJECT", conversationId: "shared-1", projectName }, "telegram");
    await f.controller.handle({ type: "USE_PROJECT", conversationId: "shared-1", projectName }, "feishu");
    const created = await f.controller.handle({ type: "CREATE_TASK", conversationId: "shared-1", request: "gate me" }, "telegram");
    const taskId = /Task created: (\S+)/.exec(created.text)![1]!;
    // Second platform also takes interest in the same task.
    f.dispatcher.subscribe("shared-1", taskId, "feishu");
    await f.controller.handle({ type: "RUN_TASK", conversationId: "shared-1", taskId, preset: "careful" }, "telegram");

    await f.orchestrator!.start();
    await f.dispatcher.start();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !f.notifications.some((n) => n.text.includes("Approval needed"))) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await f.orchestrator!.stop();
    await f.dispatcher.stop();

    const approvalNotices = f.notifications.filter((n) => n.text.includes("Approval needed"));
    assert.ok(approvalNotices.length >= 2, `both subscriptions notified: ${JSON.stringify(f.notifications)}`);
    assert.ok(approvalNotices.some((n) => n.adapter === "telegram" && n.conversationId === "shared-1"));
    assert.ok(approvalNotices.some((n) => n.adapter === "feishu" && n.conversationId === "shared-1"));
    const runId = (f.db.prepare("SELECT wr.id FROM workflow_runs wr JOIN task_revisions tr ON wr.task_revision_id = tr.id WHERE tr.task_id = ?").get(taskId) as { id: string }).id;
    assert.ok(approvalNotices.every((n) => n.text.includes(`/approve ${runId}`)), "the notification carries the actionable run id");
  } finally { await f.cleanup(); }
});

test("contract: handler (desktop) and IM (telegram) produce the same domain operation", async () => {
  const f = fixture();
  try {
    const projectId = project(f);
    // Same operation through both surfaces.
    const viaHandler = await createTask(f.commands, { projectId, request: "same op", actor: "desktop" }) as TaskDetails;
    await f.controller.handle({ type: "USE_PROJECT", conversationId: "c1", projectName: f.app.projects.list()[0]!.name }, "telegram");
    const imReply = await f.controller.handle({ type: "CREATE_TASK", conversationId: "c1", request: "same op im" }, "telegram");
    const imTaskId = /Task created: (\S+)/.exec(imReply.text)![1]!;
    // Both tasks share the same shape and lifecycle state.
    for (const taskId of [viaHandler.task.id, imTaskId]) {
      const details = f.app.tasks.show(taskId);
      assert.equal(details.task.state, "DRAFT");
      assert.equal(details.task.currentRevision, 1);
      assert.equal(f.app.activity.listForTask(taskId, 10)[0]!.type, "task.created");
    }
    const actors = f.app.activity.listForTask(viaHandler.task.id, 10)[0]!.actor + "|" + f.app.activity.listForTask(imTaskId, 10)[0]!.actor;
    assert.equal(actors, "desktop|telegram", "identical operation, differing only in actor");
  } finally { await f.cleanup(); }
});

test("concurrency: two reject decisions (desktop + telegram) yield exactly one durable decision", async () => {
  const f = fixture();
  try {
    const projectId = project(f);
    const { task } = f.app.tasks.create(projectId, "parked");
    await f.app.worktrees.prepare(task.id);
    const started = f.app.workflows.start({ taskId: task.id, preset: "careful" });
    await f.app.workflows.execute(started.run.id); // park at the gate
    const results = await Promise.allSettled([
      approveRun(f.commands, { runId: started.run.id, approved: false, actor: "desktop" }),
      approveRun(f.commands, { runId: started.run.id, approved: false, actor: "telegram" }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const conflicted = results.filter((r) => r.status === "rejected" && (r as PromiseRejectedResult).reason instanceof StateConflictError);
    assert.equal(fulfilled.length, 1, "the first decision wins");
    assert.equal(conflicted.length, 1, "the stale second decision conflicts");
    const decided = f.app.activity.listForTask(task.id, 50).filter((event) => event.type === "approval.decided");
    assert.equal(decided.length, 1, `exactly one approval.decided: ${JSON.stringify(decided)}`);
    assert.equal(f.app.workflows.status(started.run.id).run.state, "CANCELLED");
  } finally { await f.cleanup(); }
});

test("approve-vs-approve on careful: the second approve is a conflict, one durable decision", async () => {
  const f = fixture();
  try {
    const projectId = project(f);
    const { task } = f.app.tasks.create(projectId, "double approve");
    await f.app.worktrees.prepare(task.id);
    const started = f.app.workflows.start({ taskId: task.id, preset: "careful" });
    await f.app.workflows.execute(started.run.id); // parked at gate 1
    const first = await approveRun(f.commands, { runId: started.run.id, approved: true, actor: "desktop" }) as WorkflowStatus;
    assert.equal(first.steps.filter((s) => s.stepType === "HUMAN_APPROVAL")[0]!.state, "SUCCEEDED");
    // Gate 2 is not pending (earlier steps unfinished): a second approve conflicts.
    await assert.rejects(approveRun(f.commands, { runId: started.run.id, approved: true, actor: "telegram" }), /no pending approval gate/);
    const decided = f.app.activity.listForTask(task.id, 50).filter((event) => event.type === "approval.decided");
    assert.equal(decided.length, 1);
    // Approving mid-execution (future gate) is also refused: resume and park at gate 2 works.
    const paused = await f.app.workflows.execute(started.run.id);
    assert.equal(paused.awaitingApproval, true);
    const second = await approveRun(f.commands, { runId: started.run.id, approved: true, actor: "telegram" }) as WorkflowStatus;
    assert.ok(second.steps.every((s) => s.stepType !== "HUMAN_APPROVAL" || s.state === "SUCCEEDED"));
  } finally { await f.cleanup(); }
});

test("concurrency: cancel then approve — one wins, the other conflicts", async () => {
  const f = fixture();
  try {
    const projectId = project(f);
    const { task } = f.app.tasks.create(projectId, "race");
    await f.app.worktrees.prepare(task.id);
    const started = f.app.workflows.start({ taskId: task.id, preset: "careful" });
    const cancelled = await cancelRun(f.commands, { runId: started.run.id, actor: "telegram" }) as WorkflowStatus;
    assert.equal(cancelled.run.state, "CANCELLED");
    await assert.rejects(approveRun(f.commands, { runId: started.run.id, approved: true, actor: "desktop" }), StateConflictError);
    assert.equal(f.app.workflows.status(started.run.id).run.state, "CANCELLED", "the cancelled run is untouched by the losing decision");
  } finally { await f.cleanup(); }
});

test("revise during a parked run keeps the run pinned to its revision", async () => {
  const f = fixture();
  try {
    const projectId = project(f);
    const { task } = f.app.tasks.create(projectId, "revise mid-gate");
    await f.app.worktrees.prepare(task.id);
    const started = f.app.workflows.start({ taskId: task.id, preset: "careful" });
    await f.app.workflows.execute(started.run.id); // park at the gate
    const revision = await reviseTask(f.commands, { taskId: task.id, request: "updated requirement", actor: "telegram" }) as { revision: number };
    assert.equal(revision.revision, 2);
    const approved = await approveRun(f.commands, { runId: started.run.id, approved: true, actor: "desktop" }) as WorkflowStatus;
    assert.equal(approved.run.taskRevisionId, started.run.taskRevisionId, "run stays pinned to revision 1");
    assert.equal(f.app.tasks.show(task.id).task.currentRevision, 2);
  } finally { await f.cleanup(); }
});

test("approval.requested sweep republishes the notification a crashed worker lost", async () => {
  const f = fixture({ withOrchestrator: true });
  try {
    const projectId = project(f);
    const { task } = f.app.tasks.create(projectId, "crash before notify");
    await f.app.worktrees.prepare(task.id);
    const started = f.app.workflows.start({ taskId: task.id, preset: "careful" });
    // Inline execute parks at the gate without the orchestrator's outbox publish —
    // exactly the crash-between-execute-and-publish state.
    const parked = await f.app.workflows.execute(started.run.id);
    assert.equal(parked.awaitingApproval, true);
    const count = () => (f.db.prepare("SELECT COUNT(*) c FROM outbox_events WHERE type = 'approval.requested' AND workflow_run_id = ?").get(started.run.id) as { c: number }).c;
    assert.equal(count(), 0);
    assert.equal(f.orchestrator!.notifyParkedApprovalGates(), 1, "sweep publishes the missing notification");
    assert.equal(count(), 1);
    assert.equal(f.orchestrator!.notifyParkedApprovalGates(), 0, "idempotent: no duplicate notifications");
  } finally { await f.cleanup(); }
});

test("reject publishes run.cancelled to the outbox exactly once", async () => {
  const f = fixture();
  try {
    const projectId = project(f);
    const { task } = f.app.tasks.create(projectId, "reject notify");
    await f.app.worktrees.prepare(task.id);
    const started = f.app.workflows.start({ taskId: task.id, preset: "careful" });
    await f.app.workflows.execute(started.run.id);
    await approveRun(f.commands, { runId: started.run.id, approved: false, actor: "desktop" });
    const events = f.db.prepare("SELECT type FROM outbox_events WHERE task_id = ? AND type = 'run.cancelled'").all(task.id) as { type: string }[];
    assert.equal(events.length, 1, "reject notifies subscribers of the cancellation");
  } finally { await f.cleanup(); }
});

test("cancelling a parked run publishes run.cancelled and drops the queue entry", async () => {
  const f = fixture();
  try {
    const projectId = project(f);
    const { task } = f.app.tasks.create(projectId, "parked cancel");
    await f.app.worktrees.prepare(task.id);
    const started = await startRun(f.commands, { taskId: task.id, preset: "careful", actor: "desktop" }) as WorkflowStatus;
    // Still QUEUED (never claimed): cancel publishes (no live lease) and dequeues.
    await cancelRun(f.commands, { runId: started.run.id, actor: "telegram" });
    const events = f.db.prepare("SELECT type FROM outbox_events WHERE task_id = ? AND type = 'run.cancelled'").all(task.id) as { type: string }[];
    assert.equal(events.length, 1);
    assert.equal(f.commands.queue.size(), 0, "a cancelled queued run is never picked up");
  } finally { await f.cleanup(); }
});
