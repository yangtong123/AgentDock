import * as Lark from "@larksuiteoapi/node-sdk";
import type { ImAdapter, ImCommand, ImMessage, ImReply } from "./im-adapter.js";
import { FeishuAdapter, feishuMessageBody } from "./feishu-adapter.js";

type MessageHandler = (message: ImMessage) => Promise<void>;
type ActionHandler = (command: ImCommand) => Promise<void>;

/** Narrow seams over the official SDK so tests can inject fakes. */
export interface FeishuWsClient {
  start(options: { eventDispatcher: unknown }): void | Promise<void>;
  close?(): void | Promise<void>;
}
export interface FeishuApiClient {
  im: { v1: { message: { create(input: { params: { receive_id_type: string }; data: Record<string, string> }): Promise<unknown> } } };
}
export interface FeishuWsDeps {
  wsClient?: (appId: string, appSecret: string) => FeishuWsClient;
  apiClient?: (appId: string, appSecret: string) => FeishuApiClient;
  dispatcher?: (handlers: Record<string, (data: unknown) => Promise<void>>) => unknown;
}

/**
 * Feishu/Lark over the platform's long connection (WebSocket): the SDK dials
 * out, so no public URL, tunnel, webhook port, or verification token is
 * needed — App ID + App Secret are the whole configuration, and the SDK
 * manages tenant_access_token renewal. Event handling reuses FeishuAdapter's
 * processEvent, so both transports share one domain mapping.
 */
export class FeishuWsAdapter implements ImAdapter {
  readonly name = "feishu";
  private readonly inner = new FeishuAdapter(0);
  private ws: FeishuWsClient | null = null;
  private api: FeishuApiClient | null = null;

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly deps: FeishuWsDeps = {},
  ) {}

  onMessage(handler: MessageHandler): void { this.inner.onMessage(handler); }
  onAction(handler: ActionHandler): void { this.inner.onAction(handler); }

  private apiClient(): FeishuApiClient {
    // One instance: the SDK caches tenant_access_token per client.
    this.api ??= (this.deps.apiClient ?? ((appId, appSecret) => new Lark.Client({ appId, appSecret }) as unknown as FeishuApiClient))(this.appId, this.appSecret);
    return this.api;
  }

  async start(): Promise<void> {
    const wsClientFactory = this.deps.wsClient ?? ((appId, appSecret) => new Lark.WSClient({ appId, appSecret, loggerLevel: Lark.LoggerLevel.warn }) as unknown as FeishuWsClient);
    const dispatcher = this.deps.dispatcher ?? ((handlers) => new Lark.EventDispatcher({}).register(handlers));
    const ws = wsClientFactory(this.appId, this.appSecret);
    await ws.start({
      eventDispatcher: dispatcher({
        "im.message.receive_v1": async (data) => {
          const event = data as { message?: { chat_id?: string; message_type?: string; content?: string } };
          await this.inner.processEvent({ header: { event_type: "im.message.receive_v1" }, event: { message: event.message } });
        },
        // Card callbacks over long connection: chat id lives in context.
        "card.action.trigger": async (data) => {
          const event = data as { context?: { open_chat_id?: string }; action?: { value?: Record<string, string> } };
          await this.inner.processEvent({ header: { event_type: "card.action.trigger" }, event: { context: event.context, action: event.action } });
        },
      }),
    });
    this.ws = ws;
  }

  async stop(): Promise<void> {
    const ws = this.ws;
    this.ws = null;
    await ws?.close?.();
  }

  async send(reply: ImReply): Promise<void> {
    // The SDK's WSClient drops card frames, so card.action.trigger never
    // fires over the long connection (same root cause as
    // larksuite/oapi-sdk-python#126) and interactive buttons would be dead.
    // Degrade actions to explicit text commands instead; the webhook
    // transport renders real cards.
    const hints = (reply.actions ?? []).flatMap((action) =>
      action.command.type === "APPROVE_RUN"
        ? [action.command.approved ? `/approve ${action.command.runId}` : `/reject ${action.command.runId}`]
        : []);
    // Any action at all degrades to text: a card with unknown button types
    // would be just as dead over the long connection.
    const body = (reply.actions ?? []).length === 0
      ? feishuMessageBody(reply)
      : { receive_id: reply.conversationId, msg_type: "text", content: JSON.stringify({ text: hints.length === 0 ? reply.text : `${reply.text}\n\n回复 ${hints.join(" 或 ")}` }) };
    await this.apiClient().im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: body,
    });
  }
}
