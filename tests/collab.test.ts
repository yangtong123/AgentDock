import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db/database.js";
import { createApplication } from "../src/app/application.js";
import { createRepository } from "./helpers.js";
import { WorkflowEngine } from "../src/workflows/workflow-engine.js";
import { parseReviewReport, renderFindings, validateMaxReviewRounds, DEFAULT_SESSION_POLICIES } from "../src/workflows/review-findings.js";
import { SqliteAgentThreadRepository } from "../src/agents/agent-thread-repository.js";
import { SqliteArtifactRepository } from "../src/artifacts/artifact-repository.js";
import { SqliteTaskRepository } from "../src/tasks/task-repository.js";
import { AgentThreadManager } from "../src/runtime/agent-thread-manager.js";
import { ProcessRunner } from "../src/runtime/process-runner.js";
import type { AgentRunContext } from "../src/runtime/coding-agent.js";

test("parseReviewReport extracts findings, file:line, and verdict", () => {
  const report = parseReviewReport(`Header noise
FINDING [BLOCKER] src/auth.ts:42 token leak in log
FINDING [MINOR] missing test
FINDING [MAJOR] src/db.ts:10 sql injection
VERDICT: NEEDS_FIXES`);
  assert.equal(report.verdict, "NEEDS_FIXES");
  assert.equal(report.findings.length, 3);
  assert.deepEqual(report.findings[0], { id: "F1", severity: "BLOCKER", file: "src/auth.ts", line: 42, summary: "token leak in log" });
  assert.deepEqual(report.findings[1], { id: "F2", severity: "MINOR", file: null, line: null, summary: "missing test" });
  assert.equal(renderFindings(report.findings).split("\n").length, 3);
  assert.match(renderFindings(report.findings), /\[BLOCKER\] src\/auth\.ts:42 token leak/);
});

test("parseReviewReport degrades gracefully", () => {
  const pass = parseReviewReport("All good.\nVERDICT: PASS");
  assert.equal(pass.verdict, "PASS");
  assert.equal(pass.findings.length, 0);
  const implicitFail = parseReviewReport("FINDING [NIT] trailing whitespace");
  assert.equal(implicitFail.verdict, "NEEDS_FIXES");
  const empty = parseReviewReport("");
  assert.equal(empty.verdict, "PASS");
});

test("validateMaxReviewRounds enforces the bound", () => {
  assert.equal(validateMaxReviewRounds(1), 1);
  assert.equal(validateMaxReviewRounds(5), 5);
  assert.throws(() => validateMaxReviewRounds(0), /between 1 and 10/);
  assert.throws(() => validateMaxReviewRounds(11), /between 1 and 10/);
  assert.throws(() => validateMaxReviewRounds(2.5), /between 1 and 10/);
});

test("session policies: implementer resumes, reviewers always start fresh", () => {
  assert.equal(DEFAULT_SESSION_POLICIES.IMPLEMENT, "RESUME");
  assert.equal(DEFAULT_SESSION_POLICIES.FIX, "RESUME");
  assert.equal(DEFAULT_SESSION_POLICIES.REVIEW, "FRESH");
  assert.equal(DEFAULT_SESSION_POLICIES.FINAL_REVIEW, "FRESH");
});

interface Call { role: string; provider: string; resumeThreadId: string | undefined; threadId: string; prompt: string }

interface Harness {
  app: ReturnType<typeof createApplication>;
  engine: WorkflowEngine;
  calls: Call[];
  base: string;
  db: ReturnType<typeof openDatabase>;
  threadRepo: SqliteAgentThreadRepository;
}

type Script = (call: number, context: AgentRunContext) => { exitCode?: number; stdout?: string };

function harness(script: Script): Harness {
  const base = mkdtempSync(join(tmpdir(), "agentdock-v06-"));
  createRepository(join(base, "repo"));
  const db = openDatabase(":memory:");
  const app = createApplication(db);
  const calls: Call[] = [];
  let call = 0;
  const threadRepo = new SqliteAgentThreadRepository(db);
  const runtime = new AgentThreadManager(threadRepo, new SqliteArtifactRepository(db), new SqliteTaskRepository(db), (provider) => ({
    provider,
    async run(context) {
      const response = script(call++, context);
      return { exitCode: response.exitCode ?? 0, stdout: response.stdout ?? "", stderr: "", externalSessionId: `s-${context.role}-${call}`, resumed: false };
    },
  }), join(base, "artifacts"));
  // Instrument run() to record the resume wiring the engine requests.
  const originalRun = runtime.run.bind(runtime);
  runtime.run = async (input, provider, options) => {
    const execution = await originalRun(input, provider, options);
    calls.push({ role: input.role, provider, resumeThreadId: options?.resumeThreadId, threadId: execution.thread.id, prompt: input.prompt });
    return execution;
  };
  const engine = new WorkflowEngine(app.repositories.workflows, app.repositories.tasks, app.repositories.projects, runtime, new SqliteArtifactRepository(db), new ProcessRunner());
  return { app, engine, calls, base, db, threadRepo };
}

async function readyTask(h: Harness): Promise<string> {
  const project = h.app.projects.create({ name: `p-${Math.random().toString(36).slice(2)}`, repoPath: join(h.base, "repo"), worktreeRoot: join(h.base, "wt") });
  const { task } = h.app.tasks.create(project.id, "request");
  await h.app.worktrees.prepare(task.id);
  return task.id;
}

test("review NEEDS_FIXES triggers the fix loop; a passing review skips FIX", async () => {
  const findings = "FINDING [MAJOR] src/a.ts:1 fix me\nVERDICT: NEEDS_FIXES";
  const h = harness((call, context) => context.role === "REVIEW" && call < 2 ? { stdout: findings } : context.role === "REVIEW" ? { stdout: "VERDICT: PASS" } : {});
  try {
    const taskId = await readyTask(h);
    const started = await h.engine.start({ taskId, preset: "cross-review" });
    const done = await h.engine.execute(started.run.id);
    assert.equal(done.run.state, "SUCCEEDED");
    // VERIFY steps never reach the scripted agent, so the agent-call sequence shows agent steps only.
    const roles = h.calls.map((c) => c.role);
    assert.deepEqual(roles, ["IMPLEMENT", "REVIEW", "FIX", "REVIEW", "FINAL_REVIEW"]);
    // The appended round exists in the step list and recorded SUCCEEDED (skipped FIX included).
    assert.equal(done.steps.filter((s) => s.stepType === "REVIEW").length, 2);
    assert.ok(done.steps.every((s) => s.state === "SUCCEEDED"));
  } finally { h.db.close(); rmSync(h.base, { recursive: true, force: true }); }
});

test("review that passes immediately skips the FIX/VERIFY/re-REVIEW block", async () => {
  const h = harness((call, context) => context.role === "REVIEW" ? { stdout: "VERDICT: PASS" } : {});
  try {
    const taskId = await readyTask(h);
    const started = await h.engine.start({ taskId, preset: "cross-review" });
    const done = await h.engine.execute(started.run.id);
    assert.equal(done.run.state, "SUCCEEDED");
    const roles = h.calls.map((c) => c.role);
    assert.deepEqual(roles, ["IMPLEMENT", "REVIEW", "FINAL_REVIEW"]);
    assert.ok(done.steps.every((s) => s.state === "SUCCEEDED"), "skipped steps must still record SUCCEEDED");
  } finally { h.db.close(); rmSync(h.base, { recursive: true, force: true }); }
});

test("maxReviewRounds is persisted on the run and bounds the loop across it", async () => {
  const findings = "FINDING [MAJOR] src/a.ts:1 broken\nVERDICT: NEEDS_FIXES";
  const h = harness((_call, context) => context.role === "REVIEW" ? { stdout: findings } : {});
  try {
    const taskId = await readyTask(h);
    const started = await h.engine.start({ taskId, preset: "cross-review", maxReviewRounds: 1 });
    assert.equal(started.run.maxReviewRounds, 1);
    const done = await h.engine.execute(started.run.id);
    assert.equal(done.run.state, "FAILED");
    // First NEEDS_FIXES exhausts the bound immediately: no FIX runs.
    assert.equal(h.calls.filter((c) => c.role === "REVIEW").length, 1);
    assert.equal(h.calls.filter((c) => c.role === "FIX").length, 0);
  } finally { h.db.close(); rmSync(h.base, { recursive: true, force: true }); }
});

test("findings survive an execute() restart: FIX after resume still sees them", async () => {
  const findings = "FINDING [MAJOR] src/a.ts:1 fix me\nVERDICT: NEEDS_FIXES";
  // REVIEW reports findings; the first engine "crashes" right after the review round is appended.
  const h = harness((call, context) => {
    if (context.role === "REVIEW" && call === 1) return { stdout: findings }; // call 0 is IMPLEMENT
    if (context.role === "REVIEW") return { stdout: "VERDICT: PASS" };
    return {};
  });
  try {
    const taskId = await readyTask(h);
    const started = await h.engine.start({ taskId, preset: "cross-review" });
    const runId = started.run.id;
    // Simulate a process crash after REVIEW: execute() aborts with an unhandled error.
    const crashEngine = h.engine as unknown as { executeStep: (...args: unknown[]) => Promise<unknown>; execute: (runId: string) => Promise<unknown> };
    const originalExecuteStep = crashEngine.executeStep.bind(h.engine);
    crashEngine.executeStep = async (...args: unknown[]) => {
      const step = args[1] as { stepType: string };
      if (step.stepType === "FIX") throw new Error("simulated crash");
      return originalExecuteStep(...args);
    };
    await assert.rejects(crashEngine.execute(runId), /simulated crash/);
    // A fresh engine resumes: findings reload from the persisted artifact.
    const engine2 = new WorkflowEngine(h.app.repositories.workflows, h.app.repositories.tasks, h.app.repositories.projects, (h.engine as unknown as { runtime: never }).runtime, new SqliteArtifactRepository(h.db), new ProcessRunner());
    const done = await engine2.execute(runId);
    assert.equal(done.run.state, "SUCCEEDED");
    const fixCall = h.calls.find((c) => c.role === "FIX");
    assert.ok(fixCall, "FIX must run after resume");
    assert.match(fixCall!.prompt, /Open findings from the latest review:/);
  } finally { h.db.close(); rmSync(h.base, { recursive: true, force: true }); }
});

test("review/fix loop is bounded by maxReviewRounds and then fails", async () => {
  const findings = "FINDING [MAJOR] src/a.ts:1 still broken\nVERDICT: NEEDS_FIXES";
  const h = harness((_call, context) => context.role === "REVIEW" ? { stdout: findings } : {});
  try {
    const taskId = await readyTask(h);
    const started = await h.engine.start({ taskId, preset: "cross-review" });
    const done = await h.engine.execute(started.run.id);
    assert.equal(done.run.state, "FAILED");
    const reviewCount = h.calls.filter((c) => c.role === "REVIEW").length;
    assert.equal(reviewCount, 3, "default maxReviewRounds=3 stops the loop on the third NEEDS_FIXES");
    assert.equal(h.calls.filter((c) => c.role === "FIX").length, 2);
  } finally { h.db.close(); rmSync(h.base, { recursive: true, force: true }); }
});

test("RESUME policy reuses the same thread for IMPLEMENT across rounds; reviewers get fresh threads", async () => {
  const findings = "FINDING [MAJOR] src/a.ts:1 fix me\nVERDICT: NEEDS_FIXES";
  const h = harness((call, context) => context.role === "REVIEW" && call < 2 ? { stdout: findings } : context.role === "REVIEW" ? { stdout: "VERDICT: PASS" } : {});
  try {
    const taskId = await readyTask(h);
    const started = await h.engine.start({ taskId, preset: "cross-review" });
    await h.engine.execute(started.run.id);
    const implementCalls = h.calls.filter((c) => c.role === "IMPLEMENT");
    assert.equal(implementCalls.length, 1);
    // FIX uses its own RESUME thread: the preset's first FIX has no resume id; the appended
    // round's FIX is skipped when the re-review passes, so exactly one FIX executes here.
    const fixCalls = h.calls.filter((c) => c.role === "FIX");
    assert.equal(fixCalls.length, 1);
    assert.equal(fixCalls[0]!.resumeThreadId, undefined);
    // Reviewers never resume.
    for (const review of h.calls.filter((c) => c.role === "REVIEW")) assert.equal(review.resumeThreadId, undefined);
  } finally { h.db.close(); rmSync(h.base, { recursive: true, force: true }); }
});

test("FIX prompt carries structured findings", async () => {
  const findings = "FINDING [BLOCKER] src/leak.ts:7 hardcoded key\nVERDICT: NEEDS_FIXES";
  const h = harness((call, context) => context.role === "REVIEW" && call < 2 ? { stdout: findings } : context.role === "REVIEW" ? { stdout: "VERDICT: PASS" } : {});
  try {
    const taskId = await readyTask(h);
    const started = await h.engine.start({ taskId, preset: "cross-review" });
    await h.engine.execute(started.run.id);
    const fixPrompt = h.calls.find((c) => c.role === "FIX")!.prompt;
    assert.match(fixPrompt, /Open findings from the latest review:/);
    assert.match(fixPrompt, /\[BLOCKER\] src\/leak\.ts:7 hardcoded key/);
  } finally { h.db.close(); rmSync(h.base, { recursive: true, force: true }); }
});
