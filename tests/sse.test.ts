import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db/database.js";
import { createApplication } from "../src/app/application.js";
import { createRepository } from "./helpers.js";
import { TaskQueue } from "../src/reliability/task-queue.js";
import { createGateway, type Gateway } from "../src/gateway/server.js";
import { SseManager } from "../src/gateway/sse.js";

const TOKEN = "test-token";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "agentdock-sse-"));
  const db = openDatabase(":memory:");
  const app = createApplication(db);
  const gateway: Gateway = createGateway({ db, app, queue: new TaskQueue(db), host: "127.0.0.1", port: 0, token: TOKEN, ssePollIntervalMs: 25 });
  return { base, db, app, gateway };
}

/** Reads an SSE response until `until` matches (or the deadline passes) and returns the accumulated text. */
async function collect(res: Response, until: (text: string) => boolean, timeoutMs = 5_000): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (!until(text) && Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 100))]);
      if (chunk === null) continue;
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return text;
}

function connect(url: string, lastEventId?: number): Promise<Response> {
  const query = lastEventId === undefined ? "" : `?lastEventId=${lastEventId}`;
  return fetch(`${url}/api/v1/events${query}`, { headers: { authorization: `Bearer ${TOKEN}` } });
}

test("SSE replays from lastEventId and delivers live events", async () => {
  const f = fixture();
  const { url } = await f.gateway.start();
  try {
    f.app.activity.record({ type: "task.created", taskId: "t1", payload: { n: 1 } });
    f.app.activity.record({ type: "run.queued", taskId: "t1", runId: "r1", payload: { n: 2 } });

    const res = await connect(url, 0);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    // Recorded after the stream is open: live delivery must reach it (poke/poll).
    f.app.activity.record({ type: "run.running", taskId: "t1", runId: "r1" });
    const text = await collect(res, (t) => t.includes("run.running"));
    assert.match(text, /id: 1\nevent: task\.created\ndata: /);
    assert.match(text, /event: run\.queued\ndata: \{[^}]*"runId":"r1"/);
    assert.match(text, /event: run\.running/);
  } finally { await f.gateway.stop(); f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("SSE reconnect with the last seen id misses nothing", async () => {
  const f = fixture();
  const { url } = await f.gateway.start();
  try {
    f.app.activity.record({ type: "task.created", taskId: "t1" });
    const first = await connect(url, 0);
    const seen = await collect(first, (text) => text.includes("task.created"));
    const lastId = Number(/id: (\d+)/.exec(seen)![1]);

    f.app.activity.record({ type: "run.queued", taskId: "t1" });
    f.app.activity.record({ type: "run.running", taskId: "t1" });

    const second = await connect(url, lastId);
    const replayed = await collect(second, (text) => text.includes("run.running"));
    assert.ok(!replayed.includes("task.created"), "already-seen events are not redelivered");
    assert.match(replayed, /event: run\.queued/);
    assert.match(replayed, /event: run\.running/);
  } finally { await f.gateway.stop(); f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("SSE sends resync when the client fell beyond the replay window", async () => {
  const f = fixture();
  const { url } = await f.gateway.start();
  try {
    for (let index = 0; index < 1001; index++) f.app.activity.record({ type: "task.created", taskId: "t1", payload: { index } });
    const res = await connect(url, 0);
    const text = await collect(res, (t) => t.includes("event: resync"));
    assert.match(text, /event: resync\ndata: \{"lastEventId":1001\}/, "client is told to refetch state and continue from latest");
  } finally { await f.gateway.stop(); f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("SSE requires auth", async () => {
  const f = fixture();
  const { url } = await f.gateway.start();
  try {
    const res = await fetch(`${url}/api/v1/events`);
    assert.equal(res.status, 401);
  } finally { await f.gateway.stop(); f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("SSE manager disconnects a client whose buffer exceeds the cap (unit)", () => {
  const db = openDatabase(":memory:");
  try {
    const app = createApplication(db);
    const sse = new SseManager(app.activity, 10_000, 60_000);
    // A fake response whose write buffer grows forever (client never drains).
    let destroyed = false;
    const fakeRes = {
      writableLength: 0,
      destroyed: false,
      writeHead() { return this; },
      flushHeaders() { return this; },
      on() { return this; },
      write(chunk: string) { this.writableLength += chunk.length; return true; },
      destroy() { this.destroyed = true; destroyed = true; return this; },
    };
    assert.equal(sse.add(fakeRes as never, 0), true);
    // One event with a payload over the 1 MiB cap: the client is dropped.
    app.activity.record({ type: "task.created", taskId: "t1", payload: { blob: "x".repeat(2 * 1024 * 1024) } });
    assert.equal(destroyed, true, "client disconnected at the buffer cap");
    assert.equal(sse.connectionCount, 0);
    sse.stop();
  } finally { db.close(); }
});

test("a connected-but-never-reading SSE client never stalls a run", async () => {
  const f = fixture();
  const { url } = await f.gateway.start();
  try {
    // Raw socket that never reads.
    const socket = await new Promise<import("node:net").Socket>((resolve, reject) => {
      const s = createConnection(Number(new URL(url).port), "127.0.0.1", () => {
        s.write(`GET /api/v1/events?token=${TOKEN} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n`);
        resolve(s);
      });
      s.on("error", reject);
    });

    const base2 = mkdtempSync(join(tmpdir(), "agentdock-sse-run-"));
    createRepository(join(base2, "repo"));
    process.env.AGENTDOCK_ARTIFACTS = join(base2, "artifacts");
    const fakeAgent = { provider: "fake", async run() { return { exitCode: 0, stdout: "done", stderr: "", externalSessionId: "s", resumed: false }; } };
    const app2 = createApplication(f.db, { agents: { claude: fakeAgent, codex: fakeAgent } });
    const project = app2.projects.create({ name: "p", repoPath: join(base2, "repo"), worktreeRoot: join(base2, "wt") });
    const { task } = app2.tasks.create(project.id, "run while slow client attached");
    await app2.worktrees.prepare(task.id);
    const started = app2.workflows.start({ taskId: task.id, preset: "fast" });
    const done = await app2.workflows.execute(started.run.id);
    assert.equal(done.run.state, "SUCCEEDED", "workflow completes while a never-reading client is attached");
    socket.destroy();
    rmSync(base2, { recursive: true, force: true });
    delete process.env.AGENTDOCK_ARTIFACTS;
  } finally { await f.gateway.stop(); f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("cursor survives a DB reopen: reconnecting with lastEventId loses nothing", async () => {
  const base = mkdtempSync(join(tmpdir(), "agentdock-sse-restart-"));
  const dbPath = join(base, "data.db");
  const db1 = openDatabase(dbPath);
  const app1 = createApplication(db1);
  app1.activity.record({ type: "task.created", taskId: "t1", payload: { n: 1 } });
  app1.activity.record({ type: "run.queued", taskId: "t1", payload: { n: 2 } });
  const gateway1 = createGateway({ db: db1, app: app1, queue: new TaskQueue(db1), host: "127.0.0.1", port: 0, token: TOKEN, ssePollIntervalMs: 25 });
  const { url } = await gateway1.start();
  try {
    const first = await connect(url, 0);
    const seen = await collect(first, (text) => text.includes('"n":2'));
    const lastId = Number(/id: (\d+)(?![\s\S]*id: )/.exec(seen)![1]);

    // Restart: close DB and gateway, reopen the same file.
    await gateway1.stop();
    db1.close();
    const db2 = openDatabase(dbPath);
    const app2 = createApplication(db2);
    // Events written while the old client was gone.
    app2.activity.record({ type: "run.running", taskId: "t1", payload: { n: 3 } });
    const gateway2 = createGateway({ db: db2, app: app2, queue: new TaskQueue(db2), host: "127.0.0.1", port: 0, token: TOKEN, ssePollIntervalMs: 25 });
    const { url: url2 } = await gateway2.start();
    try {
      const resumed = await connect(url2, lastId);
      const replayed = await collect(resumed, (text) => text.includes('"n":3'));
      assert.ok(!replayed.includes('"n":1') && !replayed.includes('"n":2'), "already-seen events are not redelivered after restart");
      assert.match(replayed, /"n":3/, "events written while away arrive from the cursor");
    } finally { await gateway2.stop(); db2.close(); }
  } finally { rmSync(base, { recursive: true, force: true }); }
});
