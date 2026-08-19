import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db/database.js";
import { createApplication } from "../src/app/application.js";
import { createRepository } from "./helpers.js";
import { TaskQueue } from "../src/reliability/task-queue.js";
import { createGateway, type Gateway } from "../src/gateway/server.js";
import type { CodingAgent } from "../src/runtime/coding-agent.js";

const TOKEN = "test-token";

function fixture(options: { fakeAgents?: boolean; agent?: CodingAgent } = {}) {
  const base = mkdtempSync(join(tmpdir(), "agentdock-gw-"));
  createRepository(join(base, "repo"));
  process.env.AGENTDOCK_ARTIFACTS = join(base, "artifacts");
  const db = openDatabase(":memory:");
  const fake: CodingAgent = options.agent ?? { provider: "fake", async run() { return { exitCode: 0, stdout: "VERDICT: PASS", stderr: "", externalSessionId: "s", resumed: false }; } };
  const app = createApplication(db, options.fakeAgents === true || options.agent !== undefined ? { agents: { claude: fake, codex: fake } } : {});
  const gateway: Gateway = createGateway({ db, app, queue: new TaskQueue(db), host: "127.0.0.1", port: 0, token: TOKEN, ssePollIntervalMs: 25 });
  return { base, db, app, gateway };
}

interface Started {
  url: string;
  close: () => Promise<void>;
}

async function started(f: ReturnType<typeof fixture>): Promise<Started> {
  const { url } = await f.gateway.start();
  return { url, close: async () => { await f.gateway.stop(); f.db.close(); rmSync(f.base, { recursive: true, force: true }); delete process.env.AGENTDOCK_ARTIFACTS; } };
}

function api(url: string, method: string, path: string, options: { body?: unknown; token?: string | null; headers?: Record<string, string> } = {}) {
  return fetch(`${url}/api/v1${path}`, {
    method,
    headers: {
      ...(options.token === null ? {} : { authorization: `Bearer ${options.token ?? TOKEN}` }),
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(options.headers ?? {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}

function project(f: ReturnType<typeof fixture>): string {
  return f.app.projects.create({ name: `p-${Math.random().toString(36).slice(2)}`, repoPath: join(f.base, "repo"), worktreeRoot: join(f.base, "wt") }).id;
}

test("auth: 401 without/with wrong token, 403 on foreign Origin", async () => {
  const f = fixture();
  const s = await started(f);
  try {
    assert.equal((await api(s.url, "GET", "/projects", { token: null })).status, 401);
    assert.equal((await api(s.url, "GET", "/projects", { token: "wrong" })).status, 401);
    const foreign = await api(s.url, "GET", "/projects", { headers: { origin: "http://example.com" } });
    assert.equal(foreign.status, 403);
    const wrongPort = await api(s.url, "GET", "/projects", { headers: { origin: "http://127.0.0.1:1" } });
    assert.equal(wrongPort.status, 403);
    const local = await api(s.url, "GET", "/projects", { headers: { origin: s.url } });
    assert.equal(local.status, 200);
    assert.equal(local.headers.get("access-control-allow-origin"), null, "no CORS allowance is ever emitted");
  } finally { await s.close(); }
});

test("400 on invalid JSON, validation failure, and missing Idempotency-Key; 404 on unknown route/task", async () => {
  const f = fixture();
  const s = await started(f);
  try {
    const badJson = await fetch(`${s.url}/api/v1/tasks`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "idempotency-key": "k-bad", "content-type": "application/json" }, body: "{not json" });
    assert.equal(badJson.status, 400);
    const noKey = await api(s.url, "POST", "/tasks", { body: { projectId: "p", request: "r" } });
    assert.equal(noKey.status, 400);
    assert.equal((await noKey.json() as { error: { code: string } }).error.code, "validation");
    const invalid = await api(s.url, "POST", "/tasks", { body: { projectId: "p" }, headers: { "idempotency-key": "k-inv" } });
    assert.equal(invalid.status, 400);
    assert.equal((await api(s.url, "GET", "/nope")).status, 404);
    assert.equal((await api(s.url, "GET", "/tasks/00000000-0000-0000-0000-000000000000")).status, 404);
    const badState = await api(s.url, "GET", "/tasks?state=BOGUS");
    assert.equal(badState.status, 400);
  } finally { await s.close(); }
});

test("full POST lifecycle: create → prepare → runs → approve → cancel, then 409 on a stale decision", async () => {
  const f = fixture({ fakeAgents: true });
  const s = await started(f);
  try {
    const projectId = project(f);
    const created = await (await api(s.url, "POST", "/tasks", { body: { projectId, request: "do it" }, headers: { "idempotency-key": "k-create" } })).json() as { task: { id: string; state: string } };
    assert.equal(created.task.state, "DRAFT");
    const prepared = await (await api(s.url, "POST", `/tasks/${created.task.id}/prepare`, { headers: { "idempotency-key": "k-prepare" } })).json() as { state: string; worktreePath: string | null };
    assert.equal(prepared.state, "READY");
    assert.ok(prepared.worktreePath !== null);
    const run = await (await api(s.url, "POST", `/tasks/${created.task.id}/runs`, { body: { preset: "careful" }, headers: { "idempotency-key": "k-run" } })).json() as { run: { id: string; state: string } };
    assert.equal(run.run.state, "QUEUED");
    // Approving before the run parks at the gate is a conflict (no pending gate).
    const early = await api(s.url, "POST", `/runs/${run.run.id}/approve`, { headers: { "idempotency-key": "k-early" } });
    assert.equal(early.status, 409);
    // Drive the run to the gate (the orchestrator's job; done inline here).
    const parked = await f.app.workflows.execute(run.run.id);
    assert.equal(parked.awaitingApproval, true);
    const approved = await api(s.url, "POST", `/runs/${run.run.id}/approve`, { headers: { "idempotency-key": "k-approve" } });
    assert.equal(approved.status, 200);
    const cancelled = await api(s.url, "POST", `/runs/${run.run.id}/cancel`, { headers: { "idempotency-key": "k-cancel" } });
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json() as { run: { state: string } }).run.state, "CANCELLED");
    const stale = await api(s.url, "POST", `/runs/${run.run.id}/approve`, { headers: { "idempotency-key": "k-approve-2" } });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json() as { error: { code: string } }).error.code, "state-conflict");
  } finally { await s.close(); }
});

test("idempotency replay returns the stored response and creates no duplicates", async () => {
  const f = fixture();
  const s = await started(f);
  try {
    const projectId = project(f);
    const first = await api(s.url, "POST", "/tasks", { body: { projectId, request: "do it" }, headers: { "idempotency-key": "k-dup" } });
    const firstBody = await first.json() as { task: { id: string } };
    const replay = await api(s.url, "POST", "/tasks", { body: { projectId, request: "do it" }, headers: { "idempotency-key": "k-dup" } });
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get("idempotency-replayed"), "true");
    assert.equal((await replay.json() as { task: { id: string } }).task.id, firstBody.task.id);
    assert.equal(f.app.tasks.list().length, 1, "replay creates no second task");

    const run = await api(s.url, "POST", `/tasks/${firstBody.task.id}/runs`, { body: { preset: "fast" }, headers: { "idempotency-key": "k-run-dup" } });
    const runBody = await run.json() as { run: { id: string } };
    const runReplay = await api(s.url, "POST", `/tasks/${firstBody.task.id}/runs`, { body: { preset: "fast" }, headers: { "idempotency-key": "k-run-dup" } });
    assert.equal(runReplay.headers.get("idempotency-replayed"), "true");
    assert.equal((await runReplay.json() as { run: { id: string } }).run.id, runBody.run.id);
    const runs = f.db.prepare("SELECT COUNT(*) c FROM workflow_runs").get() as { c: number };
    assert.equal(runs.c, 1, "replay creates no second run");
  } finally { await s.close(); }
});

test("GET reads: projects, providers, presets, tasks with filters, task detail, run status", async () => {
  const f = fixture();
  const s = await started(f);
  try {
    const projectId = project(f);
    const { task } = f.app.tasks.create(projectId, "do it");
    const started1 = await (await api(s.url, "POST", `/tasks/${task.id}/runs`, { body: { preset: "fast" }, headers: { "idempotency-key": "k-r" } })).json() as { run: { id: string } };

    const projects = await (await api(s.url, "GET", "/projects")).json() as { id: string }[];
    assert.ok(projects.some((p) => p.id === projectId));
    const providers = await (await api(s.url, "GET", "/providers")).json() as string[];
    assert.deepEqual(providers.sort(), ["claude", "codex"]);
    const presets = await (await api(s.url, "GET", "/workflow-presets")).json() as { presets: { name: string; steps: unknown[] }[]; defaultProviders: Record<string, string> };
    assert.deepEqual(presets.presets.map((p) => p.name), ["fast", "cross-review", "careful", "fix"]);
    assert.equal(presets.defaultProviders.PLAN, "claude");
    assert.ok(presets.presets.every((p) => p.steps.length > 0));

    const all = await (await api(s.url, "GET", `/tasks?projectId=${projectId}`)).json() as { id: string }[];
    assert.equal(all.length, 1);
    const running = await (await api(s.url, "GET", "/tasks?state=RUNNING")).json() as { id: string }[];
    assert.deepEqual(running.map((t) => t.id), [task.id]);
    const draft = await (await api(s.url, "GET", "/tasks?state=DRAFT")).json() as unknown[];
    assert.equal(draft.length, 0);

    const detail = await (await api(s.url, "GET", `/tasks/${task.id}`)).json() as { task: { id: string }; currentRevision: { request: string }; runs: { run: { id: string }; steps: unknown[] }[] };
    assert.equal(detail.task.id, task.id);
    assert.equal(detail.currentRevision.request, "do it");
    assert.equal(detail.runs.length, 1);
    assert.equal(detail.runs[0]!.run.id, started1.run.id);
    assert.ok(detail.runs[0]!.steps.length > 0);

    const runStatus = await (await api(s.url, "GET", `/runs/${started1.run.id}`)).json() as { run: { state: string }; steps: { durationMs: number | null }[]; awaitingApproval: boolean };
    assert.equal(runStatus.run.state, "QUEUED");
    assert.ok(runStatus.steps.every((step) => step.durationMs === null));

    const artifacts = await (await api(s.url, "GET", `/tasks/${task.id}/artifacts`)).json() as unknown[];
    assert.deepEqual(artifacts, []);
    const diff = await (await api(s.url, "GET", `/tasks/${task.id}/diff?stat=true`)).json() as { diff: string };
    assert.equal(typeof diff.diff, "string");
  } finally { await s.close(); }
});

test("step log endpoint: offset/limit paging, complete flag, stderr stream, missing step", async () => {
  const f = fixture({ fakeAgents: true });
  const s = await started(f);
  try {
    const projectId = project(f);
    const { task } = f.app.tasks.create(projectId, "do it");
    await f.app.worktrees.prepare(task.id);
    const startedRun = f.app.workflows.start({ taskId: task.id, preset: "fast" });
    await f.app.workflows.execute(startedRun.run.id);
    const implementStep = f.app.workflows.status(startedRun.run.id).steps.find((step) => step.stepType === "IMPLEMENT")!;

    // Fake agent output "VERDICT: PASS" (13 bytes) was captured into the streamed artifact.
    const page1 = await (await api(s.url, "GET", `/steps/${implementStep.id}/log?offset=0&limit=5`)).json() as { offset: number; nextOffset: number; data: string; complete: boolean };
    assert.deepEqual(page1, { offset: 0, nextOffset: 5, data: "VERDI", complete: false });
    const page2 = await (await api(s.url, "GET", `/steps/${implementStep.id}/log?offset=5&limit=100`)).json() as { nextOffset: number; data: string; complete: boolean };
    assert.equal(page2.data, "CT: PASS");
    assert.equal(page2.complete, true);
    const stderr = await (await api(s.url, "GET", `/steps/${implementStep.id}/log?stream=stderr`)).json() as { data: string; complete: boolean };
    assert.deepEqual(stderr, { offset: 0, nextOffset: 0, data: "", complete: true });
    const badStream = await api(s.url, "GET", `/steps/${implementStep.id}/log?stream=bogus`);
    assert.equal(badStream.status, 400);

    // A step that never ran has no artifact yet: empty, incomplete stream.
    f.app.repositories.tasks.update(task.id, { state: "READY" }, new Date().toISOString());
    const queued = f.app.workflows.start({ taskId: task.id, preset: "fast" });
    const queuedStep = f.app.workflows.status(queued.run.id).steps[0]!;
    const empty = await (await api(s.url, "GET", `/steps/${queuedStep.id}/log`)).json() as { data: string; complete: boolean };
    assert.deepEqual(empty, { offset: 0, nextOffset: 0, data: "", complete: false });

    assert.equal((await api(s.url, "GET", "/steps/00000000-0000-0000-0000-000000000000/log")).status, 404);
  } finally { await s.close(); }
});

test("static workbench serving: index, assets, SPA fallback, traversal rejection, no auth", async () => {
  const base = mkdtempSync(join(tmpdir(), "agentdock-gw-static-"));
  const workbenchDir = join(base, "workbench");
  mkdirSync(join(workbenchDir, "assets"), { recursive: true });
  writeFileSync(join(workbenchDir, "index.html"), "<html><body>workbench</body></html>");
  writeFileSync(join(workbenchDir, "assets", "app.js"), "console.log(1);\n");
  const db = openDatabase(":memory:");
  const app = createApplication(db);
  const gateway = createGateway({ db, app, queue: new TaskQueue(db), host: "127.0.0.1", port: 0, token: TOKEN, workbenchDir });
  const { url } = await gateway.start();
  try {
    // No auth required for the SPA shell and assets.
    const index = await fetch(`${url}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await index.text(), /workbench/);
    const js = await fetch(`${url}/assets/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /text\/javascript/);
    // SPA fallback: unknown non-api paths serve the shell.
    const spa = await fetch(`${url}/tasks/some-client-route`);
    assert.equal(spa.status, 200);
    assert.match(await spa.text(), /workbench/);
    // Traversal is rejected: encoded slashes escape the root (400); the URL
    // parser itself normalizes literal/encoded dot segments, which must at
    // worst fall through to the SPA shell — never leak file contents.
    const encoded = await fetch(`${url}/..%2f..%2fpackage.json`);
    assert.equal(encoded.status, 400);
    const encodedDots = await fetch(`${url}/%2e%2e%2f%2e%2e%2fpackage.json`);
    assert.equal(encodedDots.status, 400);
    const normalized = await fetch(`${url}/%2e%2e/%2e%2e/package.json`);
    assert.match(await normalized.text(), /workbench/, "normalized dot segments can only reach the SPA shell");
    // /api stays token-protected even though static is public.
    assert.equal((await fetch(`${url}/api/v1/projects`)).status, 401);
  } finally { await gateway.stop(); db.close(); rmSync(base, { recursive: true, force: true }); }
});

test("static serving 404s as JSON when the workbench is not built", async () => {
  const f = fixture(); // fixture passes no workbenchDir; default path does not exist in tests... use a guaranteed-missing dir
  await f.gateway.stop();
  const gateway = createGateway({ db: f.db, app: f.app, queue: new TaskQueue(f.db), host: "127.0.0.1", port: 0, token: TOKEN, workbenchDir: join(f.base, "missing") });
  const { url } = await gateway.start();
  try {
    const res = await fetch(`${url}/`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  } finally { await gateway.stop(); f.db.close(); rmSync(f.base, { recursive: true, force: true }); delete process.env.AGENTDOCK_ARTIFACTS; }
});

test("query-token auth is accepted on GET /events only (EventSource fallback)", async () => {
  const f = fixture();
  const s = await started(f);
  try {
    assert.equal((await fetch(`${s.url}/api/v1/projects?token=${TOKEN}`)).status, 401, "query token is not a general auth path");
    assert.equal((await fetch(`${s.url}/api/v1/events?token=${TOKEN}`)).status, 200);
    assert.equal((await fetch(`${s.url}/api/v1/events?token=wrong`)).status, 401);
  } finally { await s.close(); }
});

test("security headers: nosniff on API and SSE, CSP on the HTML shell", async () => {
  const base = mkdtempSync(join(tmpdir(), "agentdock-gw-sec-"));
  const workbenchDir = join(base, "workbench");
  mkdirSync(workbenchDir, { recursive: true });
  writeFileSync(join(workbenchDir, "index.html"), "<html></html>");
  writeFileSync(join(workbenchDir, "app.css"), "body{}");
  const db = openDatabase(":memory:");
  const app = createApplication(db);
  const gateway = createGateway({ db, app, queue: new TaskQueue(db), host: "127.0.0.1", port: 0, token: TOKEN, workbenchDir, ssePollIntervalMs: 25 });
  const { url } = await gateway.start();
  try {
    const apiRes = await fetch(`${url}/api/v1/projects`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(apiRes.headers.get("x-content-type-options"), "nosniff");
    const html = await fetch(`${url}/`);
    assert.equal(html.headers.get("x-content-type-options"), "nosniff");
    assert.match(html.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    const js = await fetch(`${url}/app.css`);
    assert.equal(js.headers.get("content-security-policy"), null, "CSP only on the HTML shell");
    const sse = await fetch(`${url}/api/v1/events?token=${TOKEN}`);
    assert.equal(sse.headers.get("x-content-type-options"), "nosniff");
    await sse.body?.cancel();
  } finally { await gateway.stop(); db.close(); rmSync(base, { recursive: true, force: true }); }
});

test("static stream failure (unreadable file) returns an error instead of crashing", async () => {
  const base = mkdtempSync(join(tmpdir(), "agentdock-gw-err-"));
  const workbenchDir = join(base, "workbench");
  mkdirSync(workbenchDir, { recursive: true });
  writeFileSync(join(workbenchDir, "index.html"), "<html></html>");
  const locked = join(workbenchDir, "locked.js");
  writeFileSync(locked, "x");
  chmodSync(locked, 0o000);
  const db = openDatabase(":memory:");
  const app = createApplication(db);
  const gateway = createGateway({ db, app, queue: new TaskQueue(db), host: "127.0.0.1", port: 0, token: TOKEN, workbenchDir });
  const { url } = await gateway.start();
  try {
    const res = await fetch(`${url}/locked.js`);
    assert.ok(res.status === 404 || res.status === 500, `expected an error status, got ${res.status}`);
    // The server survived: another request works.
    assert.equal((await fetch(`${url}/`)).status, 200);
  } finally { await gateway.stop(); chmodSync(locked, 0o644); db.close(); rmSync(base, { recursive: true, force: true }); }
});

test("log endpoint never splits a multi-byte UTF-8 character across chunks", async () => {
  // 4-byte emoji output, paged with a limit that lands mid-character.
  const emojiAgent: CodingAgent = { provider: "fake", async run() { return { exitCode: 0, stdout: "ab🙂cd", stderr: "", externalSessionId: "s", resumed: false }; } };
  const f = fixture({ agent: emojiAgent });
  const s = await started(f);
  try {
    const projectId = project(f);
    const { task } = f.app.tasks.create(projectId, "unicode");
    await f.app.worktrees.prepare(task.id);
    const run = f.app.workflows.start({ taskId: task.id, preset: "fast" });
    await f.app.workflows.execute(run.run.id);
    const step = f.app.workflows.status(run.run.id).steps.find((entry) => entry.stepType === "IMPLEMENT")!;
    // "ab🙂cd" = 1+1+4+1+1 bytes; limit 4 cuts inside the emoji.
    const page1 = await (await api(s.url, "GET", `/steps/${step.id}/log?offset=0&limit=4`)).json() as { data: string; nextOffset: number; complete: boolean };
    assert.equal(page1.data, "ab", "the incomplete sequence is held back, not replaced with U+FFFD");
    assert.equal(page1.nextOffset, 2);
    assert.equal(page1.complete, false);
    const page2 = await (await api(s.url, "GET", `/steps/${step.id}/log?offset=2&limit=64`)).json() as { data: string; complete: boolean };
    assert.equal(page2.data, "🙂cd");
    assert.equal(page2.complete, true);
  } finally { await s.close(); }
});

test("diff endpoint caps bytes with maxBytes and reports truncation", async () => {
  const f = fixture();
  const s = await started(f);
  try {
    const projectId = project(f);
    const { task } = f.app.tasks.create(projectId, "big change");
    const prepared = await f.app.worktrees.prepare(task.id);
    // Modify a tracked file: untracked files are not part of `git diff`.
    writeFileSync(join(prepared.worktreePath!, "README.md"), `x`.repeat(5000));
    const capped = await (await api(s.url, "GET", `/tasks/${task.id}/diff?maxBytes=200`)).json() as { diff: string; truncated: boolean; totalBytes: number };
    assert.equal(capped.truncated, true);
    assert.ok(capped.totalBytes > 200);
    assert.ok(Buffer.byteLength(capped.diff, "utf8") <= 210, `capped body stays small (got ${Buffer.byteLength(capped.diff, "utf8")})`);
    const full = await (await api(s.url, "GET", `/tasks/${task.id}/diff`)).json() as { diff: string; truncated: boolean; totalBytes: number };
    assert.equal(full.truncated, false);
    assert.equal(full.totalBytes, capped.totalBytes);
    assert.ok(full.diff.length > capped.diff.length);
    assert.equal((await api(s.url, "GET", `/tasks/${task.id}/diff?maxBytes=0`)).status, 400);
  } finally { await s.close(); }
});

test("task activity endpoint returns the newest events last", async () => {
  const f = fixture();
  const s = await started(f);
  try {
    const projectId = project(f);
    const { task } = f.app.tasks.create(projectId, "do it");
    f.app.activity.record({ type: "task.created", taskId: task.id, actor: "cli" });
    f.app.activity.record({ type: "task.prepared", taskId: task.id, actor: "desktop" });
    f.app.activity.record({ type: "run.queued", taskId: task.id, actor: "desktop" });
    const events = await (await api(s.url, "GET", `/tasks/${task.id}/activity?limit=2`)).json() as { type: string; actor: string | null }[];
    assert.deepEqual(events.map((e) => e.type), ["task.prepared", "run.queued"], "latest two, oldest first");
    assert.equal(events[0]!.actor, "desktop");
    const all = await (await api(s.url, "GET", `/tasks/${task.id}/activity`)).json() as unknown[];
    assert.equal(all.length, 3);
    assert.equal((await api(s.url, "GET", "/tasks/00000000-0000-0000-0000-000000000000/activity")).status, 404);
  } finally { await s.close(); }
});

test("task list carries latestRun attention state; run detail carries reviewRound", async () => {
  const f = fixture({ fakeAgents: true });
  const s = await started(f);
  try {
    const projectId = project(f);
    const { task } = f.app.tasks.create(projectId, "do it");
    await f.app.worktrees.prepare(task.id);
    const startedRun = f.app.workflows.start({ taskId: task.id, preset: "cross-review" });
    const tasks = await (await api(s.url, "GET", `/tasks?projectId=${projectId}`)).json() as { id: string; latestRun: { id: string; state: string; awaitingApproval: boolean } | null }[];
    assert.equal(tasks[0]!.latestRun!.id, startedRun.run.id);
    assert.equal(tasks[0]!.latestRun!.state, "QUEUED");

    await f.app.workflows.execute(startedRun.run.id);
    const detail = await (await api(s.url, "GET", `/runs/${startedRun.run.id}`)).json() as { steps: { stepType: string; reviewRound: number | null; durationMs: number | null }[] };
    const implement = detail.steps.find((step) => step.stepType === "IMPLEMENT")!;
    const review = detail.steps.find((step) => step.stepType === "REVIEW")!;
    const fix = detail.steps.find((step) => step.stepType === "FIX")!;
    const finalReview = detail.steps.find((step) => step.stepType === "FINAL_REVIEW")!;
    assert.equal(implement.reviewRound, null);
    assert.equal(review.reviewRound, 1);
    assert.equal(fix.reviewRound, 1, "FIX is labeled with the round whose findings it addresses");
    assert.equal(finalReview.reviewRound, 2, "FINAL_REVIEW opens the next round after the first REVIEW succeeded");
    assert.ok(implement.durationMs !== null, "executed steps carry a duration");
  } finally { await s.close(); }
});

test("POST /runs/:id/retry accepts a validated providers override", async () => {
  const f = fixture();
  const s = await started(f);
  try {
    const projectId = project(f);
    const created = await (await api(s.url, "POST", "/tasks", { body: { projectId, request: "do it" }, headers: { "idempotency-key": "k-c" } })).json() as { task: { id: string } };
    const run = await (await api(s.url, "POST", `/tasks/${created.task.id}/runs`, { body: { preset: "cross-review", providers: { IMPLEMENT: "codex" } }, headers: { "idempotency-key": "k-r" } })).json() as { run: { id: string } };
    await api(s.url, "POST", `/runs/${run.run.id}/cancel`, { headers: { "idempotency-key": "k-x" } });

    const badProvider = await api(s.url, "POST", `/runs/${run.run.id}/retry`, { body: { providers: { IMPLEMENT: "gpt-x" } }, headers: { "idempotency-key": "k-retry-bad" } });
    assert.equal(badProvider.status, 400);
    const badStep = await api(s.url, "POST", `/runs/${run.run.id}/retry`, { body: { providers: { DEPLOY: "claude" } }, headers: { "idempotency-key": "k-retry-bad2" } });
    assert.equal(badStep.status, 400);

    const swapped = await api(s.url, "POST", `/runs/${run.run.id}/retry`, { body: { providers: { IMPLEMENT: "claude" } }, headers: { "idempotency-key": "k-retry" } });
    assert.equal(swapped.status, 200);
    const swappedBody = await swapped.json() as { run: { id: string }; steps: { stepType: string; provider: string | null }[] };
    assert.notEqual(swappedBody.run.id, run.run.id);
    assert.equal(swappedBody.steps.find((step) => step.stepType === "IMPLEMENT")!.provider, "claude");
  } finally { await s.close(); }
});

test("expectedRunState over the API: mismatch 409s, match proceeds", async () => {
  const f = fixture({ fakeAgents: true });
  const s = await started(f);
  try {
    const projectId = project(f);
    const created = await (await api(s.url, "POST", "/tasks", { body: { projectId, request: "do it" }, headers: { "idempotency-key": "k-c2" } })).json() as { task: { id: string } };
    const run = await (await api(s.url, "POST", `/tasks/${created.task.id}/runs`, { body: { preset: "careful" }, headers: { "idempotency-key": "k-r2" } })).json() as { run: { id: string } };
    await f.app.workflows.execute(run.run.id); // park at the gate; run is RUNNING
    const mismatch = await api(s.url, "POST", `/runs/${run.run.id}/approve`, { body: { expectedRunState: "QUEUED" }, headers: { "idempotency-key": "k-a-mismatch" } });
    assert.equal(mismatch.status, 409);
    const match = await api(s.url, "POST", `/runs/${run.run.id}/approve`, { body: { expectedRunState: "RUNNING" }, headers: { "idempotency-key": "k-a-match" } });
    assert.equal(match.status, 200);
    const bogus = await api(s.url, "POST", `/runs/${run.run.id}/approve`, { body: { expectedRunState: "BOGUS" }, headers: { "idempotency-key": "k-a-bogus" } });
    assert.equal(bogus.status, 400);
  } finally { await s.close(); }
});
