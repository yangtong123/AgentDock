import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db/database.js";
import { createApplication, type Application } from "../src/app/application.js";
import { createRepository } from "./helpers.js";
import { expandPreset } from "../src/workflows/presets.js";
import { WorkflowEngine } from "../src/workflows/workflow-engine.js";
import type { CodingAgent, AgentRunContext } from "../src/runtime/coding-agent.js";
import { SqliteAgentThreadRepository } from "../src/agents/agent-thread-repository.js";
import { SqliteArtifactRepository } from "../src/artifacts/artifact-repository.js";
import { SqliteTaskRepository } from "../src/tasks/task-repository.js";
import { AgentThreadManager } from "../src/runtime/agent-thread-manager.js";
import { ProcessRunner } from "../src/runtime/process-runner.js";

test("presets expand to the documented sequences", () => {
  assert.deepEqual(expandPreset("fast").map((s) => s.stepType), ["IMPLEMENT", "VERIFY"]);
  assert.deepEqual(expandPreset("cross-review").map((s) => s.stepType), ["IMPLEMENT", "VERIFY", "REVIEW", "FIX", "VERIFY", "FINAL_REVIEW"]);
  assert.deepEqual(expandPreset("careful").map((s) => s.stepType), ["PLAN", "HUMAN_APPROVAL", "IMPLEMENT", "VERIFY", "REVIEW", "FIX", "VERIFY", "FINAL_REVIEW", "HUMAN_APPROVAL"]);
  assert.throws(() => expandPreset("bogus"), /Unknown workflow preset/);
});

test("preset provider defaults differ per step and can be overridden", () => {
  const defaults = expandPreset("cross-review");
  assert.equal(defaults.find((s) => s.stepType === "IMPLEMENT")!.provider, "claude");
  assert.equal(defaults.find((s) => s.stepType === "REVIEW")!.provider, "codex");
  const overridden = expandPreset("fast", { IMPLEMENT: "codex", VERIFY: "claude" });
  assert.equal(overridden.find((s) => s.stepType === "IMPLEMENT")!.provider, "codex");
  assert.equal(overridden.find((s) => s.stepType === "VERIFY")!.provider, "claude");
});

interface Harness {
  app: Application;
  engine: WorkflowEngine;
  calls: { step: string; provider: string; context: AgentRunContext }[];
  base: string;
  db: ReturnType<typeof openDatabase>;
}

function harness(agentBehavior: (role: string) => { fail: boolean } = () => ({ fail: false }), reviewStdout = "No blocking issues.\nVERDICT: PASS"): Harness {
  const base = mkdtempSync(join(tmpdir(), "agentdock-wf-"));
  createRepository(join(base, "repo"));
  const db = openDatabase(":memory:");
  const app = createApplication(db);
  const calls: Harness["calls"] = [];
  const threads = new SqliteAgentThreadRepository(db);
  const artifacts = new SqliteArtifactRepository(db);
  const taskRepo = new SqliteTaskRepository(db);
  const runtime = new AgentThreadManager(threads, artifacts, taskRepo, (provider) => ({
    provider,
    async run(context) {
      calls.push({ step: context.role, provider, context });
      if (agentBehavior(context.role).fail) return { exitCode: 1, stdout: "", stderr: "boom", externalSessionId: null, resumed: false };
      const stdout = context.role === "REVIEW" ? reviewStdout : `${context.role}:${provider} done`;
      return { exitCode: 0, stdout, stderr: "", externalSessionId: `sess-${context.role}`, resumed: false };
    },
  }), join(base, "artifacts"));
  const engine = new WorkflowEngine(app.repositories.workflows, taskRepo, app.repositories.projects, runtime, new ProcessRunner());
  return { app, engine, calls, base, db };
}

async function readyTask(h: Harness, options: { request?: string; verifyCommand?: string[] | null } = {}): Promise<string> {
  const project = h.app.projects.create({ name: `p-${Math.random().toString(36).slice(2)}`, repoPath: join(h.base, "repo"), worktreeRoot: join(h.base, "wt"), ...(options.verifyCommand === undefined ? {} : { verifyCommand: options.verifyCommand }) });
  const { task } = h.app.tasks.create(project.id, options.request ?? "build the feature");
  await h.app.worktrees.prepare(task.id);
  return task.id;
}

test("fast preset runs IMPLEMENT then VERIFY and succeeds", async () => {
  const h = harness();
  try {
    const taskId = await readyTask(h);
    const started = await h.engine.start({ taskId, preset: "fast" });
    assert.equal(started.run.state, "QUEUED");
    const done = await h.engine.execute(started.run.id);
    assert.equal(done.run.state, "SUCCEEDED");
    assert.deepEqual(done.steps.map((s) => s.stepType), ["IMPLEMENT", "VERIFY"]);
    assert.ok(done.steps.every((s) => s.state === "SUCCEEDED"));
    assert.deepEqual(h.calls.map((c) => c.step), ["IMPLEMENT"]);
    assert.equal(h.app.tasks.list().find((t) => t.id === taskId)!.state, "SUCCEEDED");
  } finally { h.db.close(); rmSync(h.base, { recursive: true, force: true }); }
});

test("verify failure fails the run and the task", async () => {
  const h = harness();
  try {
    const taskId = await readyTask(h, { verifyCommand: [process.execPath, "-e", "process.exit(1)"] });
    const started = await h.engine.start({ taskId, preset: "fast" });
    const done = await h.engine.execute(started.run.id);
    assert.equal(done.run.state, "FAILED");
    assert.equal(done.steps.find((s) => s.stepType === "VERIFY")!.state, "FAILED");
    assert.equal(h.app.tasks.list().find((t) => t.id === taskId)!.state, "FAILED");
  } finally { h.db.close(); rmSync(h.base, { recursive: true, force: true }); }
});

test("verify success passes when the command exits 0", async () => {
  const h = harness();
  try {
    const taskId = await readyTask(h, { verifyCommand: [process.execPath, "-e", "process.exit(0)"] });
    const started = await h.engine.start({ taskId, preset: "fast" });
    const done = await h.engine.execute(started.run.id);
    assert.equal(done.run.state, "SUCCEEDED");
  } finally { h.db.close(); rmSync(h.base, { recursive: true, force: true }); }
});

test("agent step failure fails the run", async () => {
  const h = harness((role) => ({ fail: role === "IMPLEMENT" }));
  try {
    const taskId = await readyTask(h);
    const started = await h.engine.start({ taskId, preset: "fast" });
    const done = await h.engine.execute(started.run.id);
    assert.equal(done.run.state, "FAILED");
    assert.equal(done.steps.find((s) => s.stepType === "IMPLEMENT")!.state, "FAILED");
    assert.equal(done.steps.find((s) => s.stepType === "VERIFY")!.state, "QUEUED");
  } finally { h.db.close(); rmSync(h.base, { recursive: true, force: true }); }
});

test("careful preset pauses at the plan approval gate and resumes after approval", async () => {
  const h = harness();
  try {
    const taskId = await readyTask(h);
    const started = await h.engine.start({ taskId, preset: "careful" });
    const paused = await h.engine.execute(started.run.id);
    assert.equal(paused.awaitingApproval, true);
    assert.equal(paused.steps.find((s) => s.stepType === "PLAN")!.state, "SUCCEEDED");
    const gate = paused.steps.find((s) => s.stepType === "HUMAN_APPROVAL")!;
    assert.equal(gate.state, "QUEUED");
    // Nothing after the gate ran yet.
    assert.equal(h.calls.length, 1);
    h.engine.approve(started.run.id, true);
    const mid = await h.engine.execute(started.run.id);
    // The careful preset ends with a second HUMAN_APPROVAL gate before success.
    assert.equal(mid.awaitingApproval, true);
    h.engine.approve(started.run.id, true);
    const done = await h.engine.execute(started.run.id);
    assert.equal(done.run.state, "SUCCEEDED");
    assert.ok(done.steps.every((s) => s.state === "SUCCEEDED"));
  } finally { h.db.close(); rmSync(h.base, { recursive: true, force: true }); }
});

test("rejecting the approval gate cancels the run and task", async () => {
  const h = harness();
  try {
    const taskId = await readyTask(h);
    const started = await h.engine.start({ taskId, preset: "careful" });
    await h.engine.execute(started.run.id);
    h.engine.approve(started.run.id, false);
    const status = h.engine.status(started.run.id);
    assert.equal(status.run.state, "CANCELLED");
    assert.equal(h.app.tasks.list().find((t) => t.id === taskId)!.state, "CANCELLED");
    await assert.rejects(h.engine.execute(started.run.id), /already finished/);
  } finally { h.db.close(); rmSync(h.base, { recursive: true, force: true }); }
});

test("cancel marks run, steps, and task cancelled", async () => {
  const h = harness();
  try {
    const taskId = await readyTask(h);
    const started = await h.engine.start({ taskId, preset: "cross-review" });
    const cancelled = h.engine.cancel(started.run.id);
    assert.equal(cancelled.run.state, "CANCELLED");
    assert.ok(cancelled.steps.filter((s) => s.state === "QUEUED").length === 0);
    assert.equal(h.app.tasks.list().find((t) => t.id === taskId)!.state, "CANCELLED");
  } finally { h.db.close(); rmSync(h.base, { recursive: true, force: true }); }
});

test("workflows only start from READY tasks", async () => {
  const h = harness();
  try {
    const project = h.app.projects.create({ name: "p2", repoPath: join(h.base, "repo"), worktreeRoot: join(h.base, "wt") });
    const { task } = h.app.tasks.create(project.id, "draft task");
    await assert.rejects(h.engine.start({ taskId: task.id, preset: "fast" }), /workflows start from READY/);
  } finally { h.db.close(); rmSync(h.base, { recursive: true, force: true }); }
});

test("cross-review runs agent steps with per-step providers and skips FIX on a passing review", async () => {
  const h = harness();
  try {
    const taskId = await readyTask(h);
    const started = await h.engine.start({ taskId, preset: "cross-review" });
    const done = await h.engine.execute(started.run.id);
    assert.equal(done.run.state, "SUCCEEDED");
    assert.deepEqual(h.calls.map((c) => c.step), ["IMPLEMENT", "REVIEW", "FINAL_REVIEW"]);
    assert.deepEqual(h.calls.map((c) => c.provider), ["claude", "codex", "codex"]);
  } finally { h.db.close(); rmSync(h.base, { recursive: true, force: true }); }
});

test("cross-review FIX receives structured findings when the review reports issues", async () => {
  const h = harness(undefined, "FINDING [MAJOR] src/a.ts:1 something to fix\nVERDICT: NEEDS_FIXES");
  try {
    const taskId = await readyTask(h);
    const started = await h.engine.start({ taskId, preset: "cross-review" });
    const done = await h.engine.execute(started.run.id);
    // Review keeps reporting the same finding: the bounded loop fails after maxReviewRounds.
    assert.equal(done.run.state, "FAILED");
    const fixPrompt = h.calls.find((c) => c.step === "FIX")!.context.prompt;
    assert.match(fixPrompt, /Open findings from the latest review:/);
    assert.match(fixPrompt, /\[MAJOR\] src\/a\.ts:1 something to fix/);
  } finally { h.db.close(); rmSync(h.base, { recursive: true, force: true }); }
});

test("run stays pinned to its revision when the task is revised mid-flight", async () => {
  const h = harness();
  try {
    const taskId = await readyTask(h, { request: "original request" });
    const started = await h.engine.start({ taskId, preset: "fast" });
    h.app.tasks.revise(taskId, "changed request");
    const done = await h.engine.execute(started.run.id);
    // The run still executes the original request text captured at start().
    assert.equal(done.run.state, "SUCCEEDED");
    assert.match(h.calls[0]!.context.prompt, /original request/);
  } finally { h.db.close(); rmSync(h.base, { recursive: true, force: true }); }
});

test("cancel during execute stops the run instead of being overwritten", async () => {
  let releaseAgent: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => { releaseAgent = resolve; });
  const h = harness(() => ({ fail: false }));
  // Make the first agent call park until the test releases it, so cancel() races a RUNNING step.
  const runtime = h.engine["runtime"];
  const originalRuntimeRun = runtime.run.bind(runtime);
  let firstCall = true;
  runtime.run = async (...args: Parameters<typeof originalRuntimeRun>) => {
    if (firstCall) { firstCall = false; await gate; }
    return originalRuntimeRun(...args);
  };
  try {
    const taskId = await readyTask(h);
    const started = await h.engine.start({ taskId, preset: "cross-review" });
    const execution = h.engine.execute(started.run.id);
    await new Promise((resolve) => setTimeout(resolve, 30));
    h.engine.cancel(started.run.id);
    releaseAgent!();
    const done = await execution;
    assert.equal(done.run.state, "CANCELLED");
    assert.equal(h.engine.status(started.run.id).run.state, "CANCELLED");
    assert.equal(h.app.tasks.list().find((t) => t.id === taskId)!.state, "CANCELLED");
    // Only the in-flight step plus later steps were cancelled; nothing ran past the cancel.
    assert.equal(h.calls.length, 1);
    // The in-flight step stays CANCELLED — its late completion must not flip it to SUCCEEDED.
    assert.equal(done.steps.find((s) => s.stepType === "IMPLEMENT")!.state, "CANCELLED");
  } finally { h.db.close(); rmSync(h.base, { recursive: true, force: true }); }
});
