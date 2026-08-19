import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db/database.js";
import { createApplication } from "../src/app/application.js";
import { createRepository } from "./helpers.js";
import { ActivityLog, ACTIVITY_EVENTS } from "../src/activity/activity-log.js";
import type { CodingAgent } from "../src/runtime/coding-agent.js";

test("ActivityLog record/listSince: ordering, fields, and poke", () => {
  const db = openDatabase(":memory:");
  try {
    const log = new ActivityLog(db);
    let pokes = 0;
    const off = log.onPoke(() => { pokes++; });
    log.record({ type: ACTIVITY_EVENTS.taskCreated, taskId: "t1", actor: "cli", payload: { request: "do it" } });
    log.record({ type: ACTIVITY_EVENTS.runQueued, taskId: "t1", runId: "r1" });
    log.record({ type: ACTIVITY_EVENTS.stepStarted, taskId: "t2", stepRunId: "s1", payload: { stepType: "IMPLEMENT" } });
    assert.equal(pokes, 3);
    off();
    log.record({ type: ACTIVITY_EVENTS.taskCreated, taskId: "t3" });
    assert.equal(pokes, 3, "unsubscribed listener is no longer poked");

    const all = log.listSince(0, 100);
    assert.equal(all.length, 4);
    assert.deepEqual(all.map((e) => e.type), ["task.created", "run.queued", "step.started", "task.created"]);
    assert.ok(all.every((e, i) => i === 0 || e.id > all[i - 1]!.id), "ids are monotonic");
    assert.equal(all[0]!.taskId, "t1");
    assert.equal(all[0]!.actor, "cli");
    assert.deepEqual(JSON.parse(all[0]!.payload), { request: "do it" });
    assert.equal(all[1]!.workflowRunId, "r1");
    assert.equal(all[1]!.stepRunId, null);
    assert.deepEqual(JSON.parse(all[1]!.payload), {}, "payload defaults to {}");
    assert.equal(all[2]!.stepRunId, "s1");

    const since = log.listSince(all[0]!.id, 2);
    assert.deepEqual(since.map((e) => e.type), ["run.queued", "step.started"], "cursor and limit are honored");
  } finally { db.close(); }
});

function fixture(agent?: CodingAgent) {
  const base = mkdtempSync(join(tmpdir(), "agentdock-act-"));
  createRepository(join(base, "repo"));
  process.env.AGENTDOCK_ARTIFACTS = join(base, "artifacts");
  const db = openDatabase(":memory:");
  const fake: CodingAgent = agent ?? { provider: "fake", async run() { return { exitCode: 0, stdout: "VERDICT: PASS", stderr: "", externalSessionId: "s", resumed: false }; } };
  const app = createApplication(db, { agents: { claude: fake, codex: fake } });
  return { base, db, app };
}

async function readyTask(f: ReturnType<typeof fixture>): Promise<string> {
  const project = f.app.projects.create({ name: `p-${Math.random().toString(36).slice(2)}`, repoPath: join(f.base, "repo"), worktreeRoot: join(f.base, "wt") });
  const { task } = f.app.tasks.create(project.id, "do it");
  await f.app.worktrees.prepare(task.id);
  return task.id;
}

test("engine run records the full activity sequence", async () => {
  const f = fixture();
  try {
    const taskId = await readyTask(f);
    const started = f.app.workflows.start({ taskId, preset: "fast" });
    const status = await f.app.workflows.execute(started.run.id);
    assert.equal(status.run.state, "SUCCEEDED");

    const types = f.app.activity.listSince(0, 100).map((e) => e.type);
    assert.deepEqual(types, [
      "run.running",
      "step.started",
      "artifact.created",
      "artifact.created",
      "step.succeeded",
      "step.started",
      "step.succeeded",
      "verify.completed",
      "run.succeeded",
      "task.succeeded",
    ]);
    const events = f.app.activity.listSince(0, 100);
    assert.ok(events.every((e) => e.taskId === taskId && e.workflowRunId === started.run.id));
    const stepStarted = events.filter((e) => e.type === "step.started");
    assert.deepEqual(stepStarted.map((e) => (JSON.parse(e.payload) as { stepType: string }).stepType), ["IMPLEMENT", "VERIFY"]);
    assert.deepEqual(JSON.parse(events.find((e) => e.type === "verify.completed")!.payload), { ok: true, output: "" });
    // Streaming artifacts carry the run/step linkage from step start.
    const artifacts = f.app.repositories.artifacts.listForTask(taskId);
    assert.ok(artifacts.length >= 2);
    assert.ok(artifacts.every((a) => a.workflowRunId === started.run.id && a.stepRunId !== null));
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); delete process.env.AGENTDOCK_ARTIFACTS; }
});

test("careful preset records approval.requested and approval.decided", async () => {
  const f = fixture();
  try {
    const taskId = await readyTask(f);
    const started = f.app.workflows.start({ taskId, preset: "careful" });
    const paused = await f.app.workflows.execute(started.run.id);
    assert.equal(paused.awaitingApproval, true);

    let types = f.app.activity.listSince(0, 100).map((e) => e.type);
    assert.deepEqual(types, [
      "run.running",
      "step.started", // PLAN
      "artifact.created",
      "artifact.created",
      "step.succeeded",
      "step.started", // HUMAN_APPROVAL parks
      "approval.requested",
      "run.paused",
    ]);

    f.app.workflows.approve(started.run.id, true, { actor: "tester" });
    const events = f.app.activity.listSince(0, 100);
    const decided = events.find((e) => e.type === "approval.decided")!;
    assert.equal(decided.actor, "tester");
    assert.equal(decided.workflowRunId, started.run.id);
    assert.deepEqual(JSON.parse(decided.payload), { approved: true });
    types = events.map((e) => e.type);
    assert.ok(types.indexOf("approval.decided") > types.indexOf("approval.requested"));
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); delete process.env.AGENTDOCK_ARTIFACTS; }
});
