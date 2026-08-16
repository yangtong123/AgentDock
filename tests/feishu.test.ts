import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db/database.js";
import { createApplication } from "../src/app/application.js";
import { createRepository } from "./helpers.js";
import { FeishuAdapter } from "../src/im/feishu-adapter.js";
import { ImController } from "../src/im/im-controller.js";
import type { ImAdapter, ImMessage, ImReply } from "../src/im/im-adapter.js";

async function withAdapter(verificationToken: string | null, run: (adapter: FeishuAdapter, port: number) => Promise<void>): Promise<void> {
  const port = 30000 + Math.floor(Math.random() * 20000);
  const adapter = new FeishuAdapter(port, fetch, verificationToken);
  await adapter.start();
  try { await run(adapter, port); } finally { await adapter.stop(); }
}

function post(port: number, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  return fetch(`http://127.0.0.1:${port}/webhook`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }).then(async (response) => ({ status: response.status, text: await response.text() }));
}

test("FeishuAdapter answers the url_verification handshake", async () => {
  await withAdapter(null, async (adapter, port) => {
    const response = await post(port, { type: "url_verification", challenge: "abc123" });
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.text).challenge, "abc123");
    void adapter;
  });
});

test("FeishuAdapter rejects events with a wrong verification token and accepts valid ones", async () => {
  await withAdapter("expected-token", async (_adapter, port) => {
    const rejected = await post(port, { header: { event_type: "im.message.receive_v1", token: "wrong" }, event: {} });
    assert.equal(rejected.status, 401);
    const accepted = await post(port, { header: { event_type: "im.message.receive_v1", token: "expected-token" }, event: {} });
    assert.equal(accepted.status, 200);
  });
});

test("FeishuAdapter routes text messages through the shared parser into ImController", async () => {
  await withAdapter(null, async (adapter) => {
    const received: ImMessage[] = [];
    adapter.onMessage(async (message) => { received.push(message); });
    await adapter.processEvent({
      header: { event_type: "im.message.receive_v1" },
      event: { message: { chat_id: "oc-1", message_type: "text", content: JSON.stringify({ text: "/projects" }) } },
    });
    assert.deepEqual(received, [{ conversationId: "oc-1", text: "/projects" }]);
    // Non-text messages are ignored.
    await adapter.processEvent({
      header: { event_type: "im.message.receive_v1" },
      event: { message: { chat_id: "oc-1", message_type: "image", content: "{}" } },
    });
    assert.equal(received.length, 1);
  });
});

test("FeishuAdapter card actions reuse the Telegram compact action payloads", async () => {
  await withAdapter(null, async (adapter) => {
    const actions: string[] = [];
    adapter.onAction(async (command) => { actions.push(command.type); });
    const runId = "12345678-1234-1234-1234-123456789012";
    await adapter.processEvent({
      header: { event_type: "card.action.trigger" },
      event: { message: { chat_id: "oc-1" }, action: { value: { payload: `ar:${runId}:1` } } },
    });
    assert.deepEqual(actions, ["APPROVE_RUN"]);
    // Garbage payloads are dropped.
    await adapter.processEvent({
      header: { event_type: "card.action.trigger" },
      event: { message: { chat_id: "oc-1" }, action: { value: { payload: "junk" } } },
    });
    assert.equal(actions.length, 1);
  });
});

test("FeishuAdapter send() posts through the open API with the tenant token", async () => {
  const calls: { url: string; auth: string | null; body: unknown }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, auth: (init?.headers as Record<string, string>)?.authorization ?? null, body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const adapter = new FeishuAdapter(0, fetchImpl, null, () => "tenant-token");
  await adapter.send({ conversationId: "oc-1", text: "hello" });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /open\.feishu\.cn/);
  assert.equal(calls[0]!.auth, "Bearer tenant-token");
  // No tenant token configured: nothing is sent.
  const silent = new FeishuAdapter(0, fetchImpl, null, () => null);
  await silent.send({ conversationId: "oc-1", text: "hello" });
  assert.equal(calls.length, 1);
});

function fakeAdapter(name: string): ImAdapter & { delivered: ImReply[]; deliverMessage: (message: ImMessage) => Promise<void> } {
  let messageHandler: ((message: ImMessage) => Promise<void>) | null = null;
  const delivered: ImReply[] = [];
  return {
    name,
    delivered,
    async start() {}, async stop() {},
    async send(reply) { delivered.push(reply); },
    onMessage(handler) { messageHandler = handler; },
    onAction() {},
    async deliverMessage(message) { await messageHandler?.(message); },
  };
}

test("a task created via Telegram is visible and controllable via Feishu", async () => {
  const base = mkdtempSync(join(tmpdir(), "agentdock-feishu-"));
  createRepository(join(base, "repo"));
  const db = openDatabase(":memory:");
  try {
    const fakeAgent = { provider: "fake", async run() { return { exitCode: 0, stdout: "VERDICT: PASS", stderr: "", externalSessionId: "s", resumed: false }; } };
    const app = createApplication(db, { agents: { claude: fakeAgent, codex: fakeAgent } });
    const controller = new ImController(db, app);
    const telegram = fakeAdapter("telegram");
    const feishu = fakeAdapter("feishu");
    controller.register(telegram);
    controller.register(feishu);

    app.projects.create({ name: "shared", repoPath: join(base, "repo"), worktreeRoot: join(base, "wt") });
    // Create via Telegram conversation.
    await telegram.deliverMessage({ conversationId: "tg-42", text: "/use shared" });
    await telegram.deliverMessage({ conversationId: "tg-42", text: "/new cross-IM task" });
    // List via a different Feishu conversation in the same project? Focus is per-conversation,
    // so Feishu user picks the project and sees the same durable task.
    await feishu.deliverMessage({ conversationId: "oc-9", text: "/use shared" });
    await feishu.deliverMessage({ conversationId: "oc-9", text: "/tasks" });
    const listed = feishu.delivered[feishu.delivered.length - 1]!;
    assert.match(listed.text, /DRAFT/);
    const tasks = app.tasks.list();
    assert.equal(tasks.length, 1, "one durable task shared across IMs");
    // Control it from Feishu: status by id.
    const status = await controller.handle({ type: "TASK_STATUS", conversationId: "oc-9", taskId: tasks[0]!.id }, "feishu");
    assert.match(status.text, /DRAFT/);
    assert.equal(telegram.delivered.length, 2, "status reply must not route back to telegram");
    assert.equal(feishu.delivered.length, 3);
  } finally { db.close(); rmSync(base, { recursive: true, force: true }); }
});
