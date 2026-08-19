import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db/database.js";
import { createApplication } from "../src/app/application.js";
import { createRepository } from "./helpers.js";
import { parseCommand, IM_RUN_PRESETS } from "../src/im/command-parser.js";
import { expandPreset } from "../src/workflows/presets.js";
import { ImController } from "../src/im/im-controller.js";
import { TelegramAdapter, decodeCallback } from "../src/im/telegram-adapter.js";
import type { ImAdapter, ImMessage, ImReply } from "../src/im/im-adapter.js";

test("parser maps /commands to domain commands and ignores chat", () => {
  const conversationId = "c1";
  assert.deepEqual(parseCommand(conversationId, "/projects"), { type: "LIST_PROJECTS", conversationId });
  assert.deepEqual(parseCommand(conversationId, "/use myrepo"), { type: "USE_PROJECT", conversationId, projectName: "myrepo" });
  assert.deepEqual(parseCommand(conversationId, "/new fix the login bug"), { type: "CREATE_TASK", conversationId, request: "fix the login bug" });
  assert.deepEqual(parseCommand(conversationId, "/tasks"), { type: "LIST_TASKS", conversationId });
  assert.deepEqual(parseCommand(conversationId, "/status t1"), { type: "TASK_STATUS", conversationId, taskId: "t1" });
  assert.deepEqual(parseCommand(conversationId, "/stop t1"), { type: "STOP_TASK", conversationId, taskId: "t1" });
  assert.deepEqual(parseCommand(conversationId, "/diff t1 --stat"), { type: "VIEW_DIFF", conversationId, taskId: "t1", statOnly: true });
  assert.deepEqual(parseCommand(conversationId, "/approve r1"), { type: "APPROVE_RUN", conversationId, runId: "r1", approved: true });
  assert.deepEqual(parseCommand(conversationId, "/reject r1"), { type: "APPROVE_RUN", conversationId, runId: "r1", approved: false });
  assert.equal(parseCommand(conversationId, "/approve"), null);
  assert.deepEqual(parseCommand(conversationId, "/start"), { type: "LIST_PROJECTS", conversationId });
  assert.equal(parseCommand(conversationId, "just chatting"), null);
  assert.equal(parseCommand(conversationId, "/new"), null);
  // Bot-name suffix tolerated.
  assert.deepEqual(parseCommand(conversationId, "/projects@agentdock_bot"), { type: "LIST_PROJECTS", conversationId });
});

function controllerFixture() {
  const base = mkdtempSync(join(tmpdir(), "agentdock-im-"));
  const repo = createRepository(join(base, "repo"));
  const db = openDatabase(":memory:");
  // Fake agents so /run never shells out to real CLIs in tests.
  const fakeAgent = { provider: "fake", async run() { return { exitCode: 0, stdout: "done", stderr: "", externalSessionId: "s", resumed: false }; } };
  const app = createApplication(db, { agents: { claude: fakeAgent, codex: fakeAgent } });
  const controller = new ImController(db, app);
  return { base, repo, db, app, controller };
}

test("controller: /use then /new creates a task in the focused project", async () => {
  const f = controllerFixture();
  try {
    const project = f.app.projects.create({ name: "demo", repoPath: f.repo, worktreeRoot: join(f.base, "wt") });
    const use = await f.controller.handle({ type: "USE_PROJECT", conversationId: "c1", projectName: "demo" });
    assert.match(use.text, /Using project demo/);
    const created = await f.controller.handle({ type: "CREATE_TASK", conversationId: "c1", request: "write tests" });
    assert.match(created.text, /Task created:/);
    const tasks = await f.controller.handle({ type: "LIST_TASKS", conversationId: "c1" });
    assert.equal((tasks.text.match(/DRAFT/g) ?? []).length, 1);
    assert.equal(f.app.tasks.list(project.id).length, 1);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("controller: /new without /use asks for a project first", async () => {
  const f = controllerFixture();
  try {
    const reply = await f.controller.handle({ type: "CREATE_TASK", conversationId: "c9", request: "do things" });
    assert.match(reply.text, /Select a project first/);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("controller: task focus persists across controller restarts", async () => {
  const f = controllerFixture();
  try {
    f.app.projects.create({ name: "demo", repoPath: f.repo, worktreeRoot: join(f.base, "wt") });
    await f.controller.handle({ type: "USE_PROJECT", conversationId: "c1", projectName: "demo" });
    const revived = new ImController(f.db, f.app);
    const created = await revived.handle({ type: "CREATE_TASK", conversationId: "c1", request: "persisted" });
    assert.match(created.text, /Task created:/);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("controller: unknown project and unknown task produce friendly errors", async () => {
  const f = controllerFixture();
  try {
    assert.match((await f.controller.handle({ type: "USE_PROJECT", conversationId: "c1", projectName: "nope" })).text, /Unknown project/);
    assert.match((await f.controller.handle({ type: "TASK_STATUS", conversationId: "c1", taskId: "missing" })).text, /Error:/);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("controller: full flow /run -> approval gate -> approve releases it", async () => {
  const f = controllerFixture();
  try {
    const project = f.app.projects.create({ name: "demo", repoPath: f.repo, worktreeRoot: join(f.base, "wt") });
    await f.controller.handle({ type: "USE_PROJECT", conversationId: "c1", projectName: "demo" });
    const created = await f.controller.handle({ type: "CREATE_TASK", conversationId: "c1", request: "careful task" });
    const taskId = (created.text.match(/Task created: (\S+)/) ?? [])[1]!;
    // Run with the fast preset (no gates) to keep the fake agent cycle simple, then careful for the gate test.
    const runReply = await f.controller.handle({ type: "RUN_TASK", conversationId: "c1", taskId, preset: "careful" });
    assert.match(runReply.text, /awaiting your approval|paused for your approval/);
    assert.ok(runReply.actions?.some((a) => a.label === "Approve"));
    const approveCommand = runReply.actions!.find((a) => a.label === "Approve")!.command;
    assert.equal(approveCommand.type, "APPROVE_RUN");
    const approved = await f.controller.handle(approveCommand);
    // No orchestrator attached in this fixture: approval executes inline.
    assert.match(approved.text, /another approval gate|finished|resumed/);
    assert.equal(f.app.tasks.list(project.id)[0]!.state !== "DRAFT", true);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("controller: /diff returns worktree diff text", async () => {
  const f = controllerFixture();
  try {
    const project = f.app.projects.create({ name: "demo", repoPath: f.repo, worktreeRoot: join(f.base, "wt") });
    const { task } = f.app.tasks.create(project.id, "diff task");
    const prepared = await f.app.worktrees.prepare(task.id);
    const { readFileSync, writeFileSync } = await import("node:fs");
    writeFileSync(join(prepared.worktreePath!, "README.md"), `${readFileSync(join(f.repo, "README.md"), "utf8")}\nchanged\n`);
    const diff = await f.controller.handle({ type: "VIEW_DIFF", conversationId: "c1", taskId: task.id, statOnly: false });
    assert.match(diff.text, /README\.md/);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

function fakeAdapter(name: string): ImAdapter & { delivered: ImReply[]; deliverMessage: (message: ImMessage) => void } {
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

test("controller routes replies through the originating adapter only", async () => {
  const f = controllerFixture();
  try {
    const telegram = fakeAdapter("telegram");
    const feishu = fakeAdapter("feishu");
    f.controller.register(telegram);
    f.controller.register(feishu);
    await telegram.deliverMessage({ conversationId: "c1", text: "/projects" });
    assert.equal(telegram.delivered.length, 1);
    assert.equal(feishu.delivered.length, 0, "a Telegram reply must not be posted to the Feishu adapter");
    // Internal broadcast (no origin) still reaches both.
    await f.controller.handle({ type: "LIST_PROJECTS", conversationId: "c1" });
    assert.equal(telegram.delivered.length, 2);
    assert.equal(feishu.delivered.length, 1);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("TelegramAdapter requires a token", () => {
  assert.throws(() => new TelegramAdapter("  "), /token is required/);
});

test("TelegramAdapter sends messages and compact inline keyboards via the Bot API", async () => {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    calls.push({ method: String(new URL(_url).pathname.split("/").pop()), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  const adapter = new TelegramAdapter("tok", fetchImpl);
  await adapter.send({ conversationId: "42", text: "hello" });
  assert.equal(calls[0]!.method, "sendMessage");
  assert.equal(calls[0]!.body.chat_id, "42");
  const runId = "12345678-1234-1234-1234-123456789012";
  await adapter.send({ conversationId: "42", text: "approve?", actions: [{ label: "Approve", command: { type: "APPROVE_RUN", conversationId: "42", runId, approved: true } }] });
  const markup = calls[1]!.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] };
  const callbackData = markup.inline_keyboard[0]![0]!.callback_data;
  assert.equal(markup.inline_keyboard[0]![0]!.text, "Approve");
  assert.ok(callbackData.length <= 64, "callback_data must fit Telegram's 64-byte limit");
  assert.equal(callbackData, `ar:${runId}:1`);
  const decoded = decodeCallback(callbackData, "42");
  assert.deepEqual(decoded, { type: "APPROVE_RUN", conversationId: "42", runId, approved: true });
});

test("decodeCallback rejects malformed and non-whitelisted payloads", () => {
  assert.equal(decodeCallback('{"type":"STOP_TASK","taskId":"x"}', "42"), null);
  assert.equal(decodeCallback("ar:not-a-uuid:1", "42"), null);
  assert.equal(decodeCallback("ar:12345678-1234-1234-1234-123456789012:2", "42"), null);
  assert.equal(decodeCallback("", "42"), null);
  assert.equal(decodeCallback("st:12345678-1234-1234-1234-123456789012", "42")!.type, "STOP_TASK");
});

test("TelegramAdapter routes updates: messages to onMessage, callbacks to onAction", async () => {
  const received: (ImMessage | string)[] = [];
  const parked: { resolve: (() => void) | null } = { resolve: null };
  const taskId = "12345678-1234-1234-1234-123456789012";
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = new URL(url).pathname.split("/").pop();
    if (method === "sendMessage" || method === "answerCallbackQuery") return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
    const body = JSON.parse(String(init?.body)) as { offset: number };
    if (body.offset <= 100) {
      return new Response(JSON.stringify({ ok: true, result: [
        { update_id: 100, message: { chat: { id: 42 }, text: "/projects" } },
        { update_id: 101, callback_query: { id: "cb1", data: `st:${taskId}`, message: { chat: { id: 42 } } } },
        { update_id: 102, callback_query: { id: "cb2", data: "garbage", message: { chat: { id: 42 } } } },
      ] }), { status: 200 });
    }
    // Later polls block until the test stops the adapter.
    await new Promise<void>((resolve) => { parked.resolve = resolve; });
    return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  const adapter = new TelegramAdapter("tok", fetchImpl, 100);
  adapter.onMessage(async (message) => { received.push(message); });
  adapter.onAction(async (command) => { received.push(JSON.stringify(command)); });
  await adapter.start();
  await new Promise((resolve) => setTimeout(resolve, 150));
  await adapter.stop();
  parked.resolve?.();
  assert.deepEqual(received[0], { conversationId: "42", text: "/projects" });
  const action = JSON.parse(String(received[1])) as { type: string; conversationId: string; taskId: string };
  assert.equal(action.type, "STOP_TASK");
  assert.equal(action.taskId, taskId);
  assert.equal(action.conversationId, "42");
  assert.equal(received.length, 2, "garbage callback payload must be dropped");
});

test("TelegramAdapter ignores chats outside ALLOWED_CHAT_IDS", async () => {
  const received: (ImMessage | string)[] = [];
  const parked: { resolve: (() => void) | null } = { resolve: null };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = new URL(url).pathname.split("/").pop();
    if (method !== "getUpdates") return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
    const body = JSON.parse(String(init?.body)) as { offset: number };
    if (body.offset <= 100) {
      return new Response(JSON.stringify({ ok: true, result: [
        { update_id: 100, message: { chat: { id: 42 }, text: "/projects" } },
        { update_id: 101, message: { chat: { id: 99 }, text: "/projects" } },
      ] }), { status: 200 });
    }
    await new Promise<void>((resolve) => { parked.resolve = resolve; });
    return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  const adapter = new TelegramAdapter("tok", fetchImpl, 100, ["42"]);
  adapter.onMessage(async (message) => { received.push(message); });
  adapter.onAction(async () => {});
  await adapter.start();
  await new Promise((resolve) => setTimeout(resolve, 150));
  await adapter.stop();
  parked.resolve?.();
  assert.deepEqual(received, [{ conversationId: "42", text: "/projects" }]);
});

test("parser: IM_RUN_PRESETS stays in lockstep with expandPreset (drift guard)", () => {
  for (const preset of IM_RUN_PRESETS) assert.ok(expandPreset(preset).length > 0, `${preset} must expand`);
  assert.throws(() => expandPreset("not-a-preset"), /Unknown workflow preset/);
});

test("parser: duplicate STEP= keys are rejected, not last-win", () => {
  assert.equal(parseCommand("c1", "/run t1 fast IMPLEMENT=claude IMPLEMENT=codex"), null);
});

test("controller: malformed /run gets a usage reply instead of silence", async () => {
  const f = controllerFixture();
  try {
    const telegram = fakeAdapter("telegram");
    f.controller.register(telegram);
    await telegram.deliverMessage({ conversationId: "c1", text: "/run abc123 bogus-preset" });
    assert.equal(telegram.delivered.length, 1);
    assert.match(telegram.delivered[0]!.text, /Usage: \/run TASK_ID PRESET/);
    assert.match(telegram.delivered[0]!.text, /fast, cross-review, careful, fix/);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test("controller: notify never broadcasts to adapters that have not seen the conversation", async () => {
  const f = controllerFixture();
  try {
    const telegram = fakeAdapter("telegram");
    const feishu = fakeAdapter("feishu");
    f.controller.register(telegram);
    f.controller.register(feishu);
    // Unknown conversation, no adapter hint: dropped, not broadcast.
    await f.controller.notify("never-seen", "hello");
    assert.equal(telegram.delivered.length, 0);
    assert.equal(feishu.delivered.length, 0);
    // Legacy subscription row (adapter '') resolves through the durable origin.
    await f.controller.handle({ type: "LIST_PROJECTS", conversationId: "legacy-1" }, "feishu");
    await f.controller.notify("legacy-1", "hi", null);
    assert.equal(feishu.delivered.filter((reply) => reply.text === "hi").length, 1);
    assert.equal(telegram.delivered.filter((reply) => reply.text === "hi").length, 0);
  } finally { f.db.close(); rmSync(f.base, { recursive: true, force: true }); }
});
