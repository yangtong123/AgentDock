import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db/database.js";
import { createApplication } from "../src/app/application.js";
import { createRepository } from "./helpers.js";
import { ImController } from "../src/im/im-controller.js";
import { Orchestrator } from "../src/reliability/orchestrator.js";

/**
 * The composed production path: ImController + Orchestrator + wired engine
 * (metrics, budgets, GitHub fix instructions). What `agentdock serve` runs.
 */
test("serve composition: IM queues through the orchestrator and metrics record real runs", async () => {
  const base = mkdtempSync(join(tmpdir(), "agentdock-e2e-"));
  createRepository(join(base, "repo"));
  const db = openDatabase(":memory:");
  try {
    const fakeAgent = { provider: "fake", async run() { return { exitCode: 0, stdout: "VERDICT: PASS", stderr: "", externalSessionId: "s", resumed: false }; } };
    const app = createApplication(db, { agents: { claude: fakeAgent, codex: fakeAgent } });
    const controller = new ImController(db, app);
    const orchestrator = new Orchestrator(db, app, app.processRunner, { pollMs: 5, heartbeatMs: 5_000 });
    controller.attachOrchestrator(orchestrator);

    const project = app.projects.create({ name: "e2e", repoPath: join(base, "repo"), worktreeRoot: join(base, "wt") });
    await controller.handle({ type: "USE_PROJECT", conversationId: "c1", projectName: "e2e" });
    const created = await controller.handle({ type: "CREATE_TASK", conversationId: "c1", request: "e2e task" });
    const taskId = (created.text.match(/Task created: (\S+)/) ?? [])[1]!;
    void project;

    await orchestrator.start();
    const queued = await controller.handle({ type: "RUN_TASK", conversationId: "c1", taskId, preset: "fast" });
    assert.match(queued.text, /queued/);
    // The orchestrator picks it up and runs it to completion.
    await new Promise((resolve) => setTimeout(resolve, 400));
    await orchestrator.stop();

    const task = app.tasks.list().find((t) => t.id === taskId)!;
    assert.equal(task.state, "SUCCEEDED", `task state was ${task.state}`);
    // Observability recorded the real run: step durations + usage exist.
    const usage = app.metrics.usageForTask(taskId);
    assert.ok(usage.length >= 1, "usage records exist for the run");
    const stepMetrics = app.metrics.stepMetrics();
    assert.ok(stepMetrics.some((m) => m.stepType === "IMPLEMENT" && m.totalDurationMs >= 0));
    // Audit captured the whole IM session.
    const audit = app.audit.list({ taskId });
    assert.ok(audit.length >= 1);
    // Outbox recorded completion.
    const events = db.prepare("SELECT type FROM outbox_events WHERE task_id = ?").all(taskId) as { type: string }[];
    assert.ok(events.some((e) => e.type === "run.succeeded"), `events: ${JSON.stringify(events)}`);
  } finally { db.close(); rmSync(base, { recursive: true, force: true }); }
});
