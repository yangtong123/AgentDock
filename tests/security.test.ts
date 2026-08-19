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
  assert.equal(restricted.osSandbox, "write-jail");
  assert.equal(restricted.failClosed, true);
  assert.equal(PROFILES["full-access"]!.osSandbox, "none");
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

/** Credential-shaped orchestrator secrets that must never reach the gateway surface. */
const SENTINELS: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: "tg-secret-sentinel-7f3a9c",
  FEISHU_APP_SECRET: "fs-secret-sentinel-2b8d1e",
  GH_TOKEN: "gh-secret-sentinel-4c5f06",
  ANTHROPIC_API_KEY: "ak-secret-sentinel-99aa11",
};

test("gateway surface never serializes orchestrator secrets", async () => {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(SENTINELS)) { saved[key] = process.env[key]; process.env[key] = value; }
  const { createGateway } = await import("../src/gateway/server.js");
  const { TaskQueue } = await import("../src/reliability/task-queue.js");
  const base = mkdtempSync(join(tmpdir(), "agentdock-sec-"));
  try {
    createRepository(join(base, "repo"));
    process.env.AGENTDOCK_ARTIFACTS = join(base, "artifacts");
    const db = openDatabase(":memory:");
    const failingAgent = { provider: "fake", async run() { return { exitCode: 1, stdout: "agent failed hard", stderr: "", externalSessionId: null, resumed: false }; } };
    const app = createApplication(db, { agents: { claude: failingAgent, codex: failingAgent } });
    const token = "test-token";
    const gateway = createGateway({ db, app, queue: new TaskQueue(db), host: "127.0.0.1", port: 0, token, ssePollIntervalMs: 25 });
    const { url } = await gateway.start();
    const bodies: string[] = [];
    const headers: string[] = [];
    const capture = async (res: Response) => {
      bodies.push(await res.text());
      for (const [name, value] of res.headers.entries()) headers.push(`${name}: ${value}`);
    };
    let requestIndex = 0;
    const api = (method: string, path: string, body?: unknown) => fetch(`${url}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json", "idempotency-key": `sec-${requestIndex++}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    const project = app.projects.create({ name: "sec", repoPath: join(base, "repo"), worktreeRoot: join(base, "wt") });
    // A failing workflow run end-to-end: agent output, review errors, activity, audit.
    const created = (await (await api("POST", "/tasks", { projectId: project.id, request: "do it" })).json()) as { task: { id: string } };
    const run = (await (await api("POST", `/tasks/${created.task.id}/runs`, { preset: "cross-review" })).json()) as { run: { id: string } };
    await app.workflows.execute(run.run.id); // fails at IMPLEMENT
    assert.equal(app.workflows.status(run.run.id).run.state, "FAILED");

    await capture(await api("GET", "/projects"));
    await capture(await api("GET", "/providers"));
    await capture(await api("GET", "/workflow-presets"));
    await capture(await api("GET", "/tasks"));
    await capture(await api("GET", `/tasks/${created.task.id}`));
    await capture(await api("GET", `/tasks/${created.task.id}/diff`));
    await capture(await api("GET", `/tasks/${created.task.id}/artifacts`));
    await capture(await api("GET", `/tasks/${created.task.id}/activity?limit=200`));
    await capture(await api("GET", `/runs/${run.run.id}`));
    const step = app.workflows.status(run.run.id).steps[0]!;
    await capture(await api("GET", `/steps/${step.id}/log`));
    await capture(await api("GET", `/steps/${step.id}/log?stream=stderr`));
    // Error paths: 400/401/404/409.
    await capture(await api("GET", "/tasks/nope"));
    await capture(await fetch(`${url}/api/v1/projects`, { headers: { authorization: "Bearer wrong" } }));
    await capture(await api("GET", "/tasks?state=BOGUS"));
    await capture(await api("POST", `/runs/${run.run.id}/cancel`, {})); // already terminal → 409
    // SSE replay of the whole history.
    const sse = await fetch(`${url}/api/v1/events?token=${token}&lastEventId=0`);
    const reader = sse.body!.getReader();
    let sseText = "";
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 50))]);
      if (chunk === null) {
        if (sseText.includes("run.failed")) break;
        continue;
      }
      if (chunk.done) break;
      sseText += new TextDecoder().decode(chunk.value, { stream: true });
    }
    await reader.cancel().catch(() => undefined);
    await gateway.stop();
    db.close();

    const everything = [...bodies, ...headers, sseText].join("\n");
    for (const [name, value] of Object.entries(SENTINELS)) {
      assert.ok(!everything.includes(value), `${name} sentinel leaked into a gateway response/event/header`);
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    delete process.env.AGENTDOCK_ARTIFACTS;
    rmSync(base, { recursive: true, force: true });
  }
});
