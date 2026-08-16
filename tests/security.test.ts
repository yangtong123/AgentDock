import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db/database.js";
import { createApplication } from "../src/app/application.js";
import { createRepository } from "./helpers.js";
import { SecretIsolation, AuditLog, PROFILES } from "../src/security/permissions.js";
import { MetricsService, BudgetGuard } from "../src/security/metrics.js";
import { agentEnvironment } from "../src/runtime/env-agents.js";

test("SecretIsolation strips credential-shaped variables", () => {
  const env = {
    PATH: "/bin", HOME: "/home/u",
    GITHUB_TOKEN: "ghp_x", TELEGRAM_BOT_TOKEN: "bot", OPENAI_API_KEY: "sk-x",
    ANTHROPIC_API_KEY: "sk-ant", MY_SERVICE_PASSWORD: "hunter2", DB_CREDENTIALS: "c",
    APP_SECRET: "s", PRIVATE_KEY: "k", SAFE_VAR: "ok",
  };
  const clean = SecretIsolation.sanitize(env);
  assert.equal(clean.PATH, "/bin");
  assert.equal(clean.SAFE_VAR, "ok");
  for (const flagged of SecretIsolation.flaggedKeys(env)) assert.equal(flagged in clean, false, `${flagged} must be stripped`);
  assert.deepEqual(SecretIsolation.flaggedKeys(env).sort(), ["ANTHROPIC_API_KEY", "APP_SECRET", "DB_CREDENTIALS", "GITHUB_TOKEN", "MY_SERVICE_PASSWORD", "OPENAI_API_KEY", "PRIVATE_KEY", "TELEGRAM_BOT_TOKEN"].sort());
});

test("agentEnvironment applies secret isolation on top of the allowlist", () => {
  const env = agentEnvironment({ PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "leak", GH_TOKEN: "leak" }, { AGENTDOCK_TASK_ID: "t1" });
  assert.equal("ANTHROPIC_API_KEY" in env, false);
  assert.equal("GH_TOKEN" in env, false);
  assert.equal(env.AGENTDOCK_TASK_ID, "t1");
});

test("permission profiles define bounded step timeouts and network policy", () => {
  const restricted = PROFILES["restricted"]!;
  const defaultProfile = PROFILES["default"]!;
  assert.ok(restricted.stepTimeoutMs < defaultProfile.stepTimeoutMs);
  assert.equal(restricted.networkAccess, false);
  assert.equal(defaultProfile.networkAccess, true);
});

test("AuditLog records and filters entries", () => {
  const db = openDatabase(":memory:");
  try {
    const audit = new AuditLog(db);
    audit.record({ actor: "telegram:42", action: "APPROVE_RUN", taskId: "t1", detail: { runId: "r1", approved: true } });
    audit.record({ actor: "cli", action: "CANCEL_TASK", taskId: "t1" });
    audit.record({ actor: "telegram:42", action: "CREATE_TASK", taskId: "t2" });
    const forTask = audit.list({ taskId: "t1" });
    assert.equal(forTask.length, 2);
    const byActor = audit.list({ actor: "telegram:42" });
    assert.equal(byActor.length, 2);
    const all = audit.list({ limit: 2 });
    assert.equal(all.length, 2);
    assert.match(all[0]!.action, /CREATE_TASK|CANCEL_TASK/);
    assert.deepEqual(JSON.parse(byActor[0]!.detail).approved ?? {}, byActor[0]!.action === "APPROVE_RUN" ? { runId: "r1", approved: true } : {});
  } finally { db.close(); }
});

function metricsFixture(): { db: ReturnType<typeof openDatabase>; app: ReturnType<typeof createApplication>; base: string; metrics: MetricsService } {
  const base = mkdtempSync(join(tmpdir(), "agentdock-metrics-"));
  createRepository(join(base, "repo"));
  const db = openDatabase(":memory:");
  const app = createApplication(db);
  const metrics = new MetricsService(db);
  return { db, app, base, metrics };
}

test("MetricsService tracks usage, step durations, and task aggregates", async () => {
  const f = metricsFixture();
  try {
    const project = f.app.projects.create({ name: "p", repoPath: join(f.base, "repo"), worktreeRoot: join(f.base, "wt") });
    const { task } = f.app.tasks.create(project.id, "metrics task");
    f.metrics.recordUsage({ taskId: task.id, provider: "claude", role: "IMPLEMENT", durationMs: 5_000, inputTokens: 100, outputTokens: 200 });
    f.metrics.recordUsage({ taskId: task.id, provider: "codex", role: "REVIEW", durationMs: 3_000 });
    const usage = f.metrics.usageForTask(task.id);
    assert.equal(usage.length, 2);
    assert.equal(usage[0]!.inputTokens, 100);
    assert.equal(usage[1]!.outputTokens, null);

    await f.app.worktrees.prepare(task.id);
    const started = await f.app.workflows.start({ taskId: task.id, preset: "fast" });
    const steps = f.app.repositories.workflows.listSteps(started.run.id);
    f.metrics.recordStepDuration(steps[0]!.id, 4_000);
    const stepMetrics = f.metrics.stepMetrics();
    assert.equal(stepMetrics.length, 2);
    const implement = stepMetrics.find((m) => m.stepType === "IMPLEMENT")!;
    assert.equal(implement.count, 1);
    assert.equal(implement.totalDurationMs, 4_000);

    f.app.repositories.tasks.update(task.id, { state: "SUCCEEDED" }, new Date().toISOString());
    const taskMetrics = f.metrics.taskMetrics();
    assert.equal(taskMetrics.tasksSucceeded, 1);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("BudgetGuard enforces step-count and duration caps", async () => {
  const f = metricsFixture();
  try {
    const project = f.app.projects.create({ name: "p", repoPath: join(f.base, "repo"), worktreeRoot: join(f.base, "wt") });
    const { task } = f.app.tasks.create(project.id, "budget task");
    await f.app.worktrees.prepare(task.id);
    await f.app.workflows.start({ taskId: task.id, preset: "fast" }); // creates 2 steps
    const guard = new BudgetGuard(f.db, f.metrics);
    assert.deepEqual(guard.withinBudget(task.id, { maxStepsPerTask: 5 }), { ok: true });
    const blocked = guard.withinBudget(task.id, { maxStepsPerTask: 2 });
    assert.equal(blocked.ok, false);
    assert.match(blocked.reason!, /maxStepsPerTask/);

    f.metrics.recordUsage({ taskId: task.id, provider: "claude", role: "IMPLEMENT", durationMs: 10_000 });
    const durationBlocked = guard.withinBudget(task.id, { maxDurationMsPerTask: 10_000 });
    assert.equal(durationBlocked.ok, false);
    assert.match(durationBlocked.reason!, /maxDurationMsPerTask/);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});
