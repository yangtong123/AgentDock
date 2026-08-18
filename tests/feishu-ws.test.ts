import assert from "node:assert/strict";
import test from "node:test";
import { FeishuWsAdapter } from "../src/im/feishu-ws-adapter.js";
import type { ImCommand, ImMessage } from "../src/im/im-adapter.js";

function wsFixture(): { adapter: FeishuWsAdapter; handlers: () => Record<string, (data: unknown) => Promise<void>> } {
  let handlers: Record<string, (data: unknown) => Promise<void>> = {};
  const adapter = new FeishuWsAdapter("app-id", "app-secret", {
    wsClient: () => ({ start(options) { handlers = options.eventDispatcher as Record<string, (data: unknown) => Promise<void>>; } }),
    dispatcher: (h) => h,
  });
  return { adapter, handlers: () => handlers };
}

test("FeishuWsAdapter routes WS message events through the shared processing", async () => {
  const { adapter, handlers } = wsFixture();
  const received: ImMessage[] = [];
  adapter.onMessage(async (message) => { received.push(message); });
  await adapter.start();
  await handlers()["im.message.receive_v1"]!({ message: { chat_id: "oc-1", message_type: "text", content: JSON.stringify({ text: "/projects" }) } });
  assert.deepEqual(received, [{ conversationId: "oc-1", text: "/projects" }]);
  await handlers()["im.message.receive_v1"]!({ message: { chat_id: "oc-1", message_type: "image", content: "{}" } });
  assert.equal(received.length, 1, "non-text messages are ignored");
  await adapter.stop();
});

test("FeishuWsAdapter routes WS card actions using the context chat id", async () => {
  const { adapter, handlers } = wsFixture();
  const commands: ImCommand[] = [];
  adapter.onAction(async (command) => { commands.push(command); });
  await adapter.start();
  const runId = "12345678-1234-1234-1234-123456789012";
  await handlers()["card.action.trigger"]!({ context: { open_chat_id: "oc-1" }, action: { value: { payload: `ar:${runId}:1` } } });
  assert.deepEqual(commands, [{ type: "APPROVE_RUN", conversationId: "oc-1", runId, approved: true }]);
  await adapter.stop();
});

test("FeishuWsAdapter send() degrades actions to text commands (card frames are dropped by the SDK)", async () => {
  const created: { params: unknown; data: Record<string, string> }[] = [];
  const adapter = new FeishuWsAdapter("app-id", "app-secret", {
    apiClient: () => ({ im: { v1: { message: { create: async (input) => { created.push(input); return {}; } } } } }),
  });
  const runId = "12345678-1234-1234-1234-123456789012";
  await adapter.send({
    conversationId: "oc-1",
    text: "paused for approval",
    actions: [
      { label: "Approve", command: { type: "APPROVE_RUN", conversationId: "oc-1", runId, approved: true } },
      { label: "Reject", command: { type: "APPROVE_RUN", conversationId: "oc-1", runId, approved: false } },
    ],
  });
  assert.equal(created.length, 1);
  assert.deepEqual(created[0]!.params, { receive_id_type: "chat_id" });
  assert.equal(created[0]!.data.msg_type, "text", "WS transport never sends dead interactive buttons");
  const text = JSON.parse(created[0]!.data.content!) as { text: string };
  assert.match(text.text, new RegExp(`/approve ${runId}`));
  assert.match(text.text, new RegExp(`/reject ${runId}`));
  // Text-only replies stay plain text.
  await adapter.send({ conversationId: "oc-1", text: "done" });
  assert.equal(created[1]!.data.msg_type, "text");
});
