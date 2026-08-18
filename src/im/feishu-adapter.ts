import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { ImAdapter, ImCommand, ImMessage, ImReply } from "./im-adapter.js";
import { parseCommand } from "./command-parser.js";
import { decodeCallback, encodeCallback } from "./telegram-adapter.js";

type MessageHandler = (message: ImMessage) => Promise<void>;
type ActionHandler = (command: ImCommand) => Promise<void>;

interface FeishuEvent {
  header?: { event_type?: string };
  /** Legacy card-callback envelope (消息卡片请求网址): chat id and action at top level. */
  open_chat_id?: string;
  action?: { value?: Record<string, string> };
  event?: {
    sender?: { sender_id?: { open_id?: string } };
    /** Event-subscription card callbacks carry the chat id here (no message object). */
    context?: { open_chat_id?: string };
    message?: { chat_id?: string; message_type?: string; content?: string };
    action?: { value?: Record<string, string> };
  };
}

/**
 * Feishu/Lark adapter. Uses the same domain-level control model as Telegram:
 * /commands go through the shared parser, interactive cards map to the same
 * compact action payloads, and replies route through ImController. Inbound
 * webhook signatures (Encrypted/Verification tokens) are verified with a
 * constant-time comparison when FEISHU_VERIFICATION_TOKEN is configured.
 */
export class FeishuAdapter implements ImAdapter {
  readonly name = "feishu";
  private messageHandler: MessageHandler | null = null;
  private actionHandler: ActionHandler | null = null;
  private server: Server | null = null;
  private readonly verificationToken: string | null;

  constructor(
    private readonly port: number,
    private readonly fetchImpl: typeof fetch = fetch,
    verificationToken: string | null = null,
    private readonly tenantTokenProvider: () => string | null = () => null,
  ) {
    this.verificationToken = verificationToken ?? null;
  }

  onMessage(handler: MessageHandler): void { this.messageHandler = handler; }
  onAction(handler: ActionHandler): void { this.actionHandler = handler; }

  async start(): Promise<void> {
    const server = createServer((request, response) => { void this.handleHttp(request, response); });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(this.port, () => resolve()));
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === null) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = null;
  }

  async send(reply: ImReply): Promise<void> {
    const token = this.tenantTokenProvider();
    if (token === null) return; // no tenant token configured: nothing to deliver
    // Actions render as an interactive card: approval gates must be
    // approvable from Feishu, not just from Telegram. Button values carry the
    // same compact payloads the inbound card.action.trigger handler decodes.
    const buttons = (reply.actions ?? [])
      .map((action) => ({ label: action.label, payload: encodeCallback(action.command) }))
      .filter((button): button is { label: string; payload: string } => button.payload !== null);
    const body = buttons.length === 0
      ? { receive_id: reply.conversationId, msg_type: "text", content: JSON.stringify({ text: reply.text }) }
      : {
          receive_id: reply.conversationId,
          msg_type: "interactive",
          content: JSON.stringify({
            config: { wide_screen_mode: true },
            header: { title: { tag: "plain_text", content: "AgentDock" }, template: "blue" },
            elements: [
              { tag: "div", text: { tag: "lark_md", content: reply.text } },
              {
                tag: "action",
                actions: buttons.map((button, index) => ({
                  tag: "button",
                  text: { tag: "plain_text", content: button.label },
                  type: index === 0 ? "primary" : "danger",
                  value: { payload: button.payload },
                })),
              },
            ],
          }),
        };
    await this.fetchImpl("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  /** Exposed for tests: single-event processing shared by HTTP and cards. */
  async processEvent(event: FeishuEvent): Promise<void> {
    // Chat id location differs by envelope: message events carry
    // event.message.chat_id; event-subscription card callbacks carry
    // event.context.open_chat_id; the legacy card callback puts open_chat_id
    // (and the action itself) at the top level.
    const chatId = event.event?.message?.chat_id ?? event.event?.context?.open_chat_id ?? event.open_chat_id ?? "";
    if (chatId === "" || !this.authorize(chatId)) return;
    if (event.header?.event_type === "im.message.receive_v1" && event.event?.message?.message_type === "text") {
      const parsed = this.parseContent(event.event.message.content);
      if (parsed !== null && this.messageHandler) await this.messageHandler({ conversationId: chatId, text: parsed });
      return;
    }
    // Card buttons carry the same compact action payloads as Telegram callbacks.
    const actionValue = event.event?.action?.value ?? event.action?.value;
    if (event.header?.event_type === "card.action.trigger" || event.action?.value !== undefined) {
      if (typeof actionValue?.payload === "string" && this.actionHandler) {
        const command = decodeCallback(actionValue.payload, chatId);
        if (command) await this.actionHandler(command);
      }
    }
  }

  private parseContent(content: string | undefined): string | null {
    if (content === undefined) return null;
    try {
      const parsed = JSON.parse(content) as { text?: string };
      return parsed.text ?? null;
    } catch {
      return null;
    }
  }

  private authorize(conversationId: string): boolean {
    if (this.allowedChatIds.size === 0) return true;
    return this.allowedChatIds.has(conversationId);
  }

  private readonly allowedChatIds: Set<string> = new Set(
    (process.env.FEISHU_ALLOWED_CHAT_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean),
  );

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST" || request.url === undefined) { response.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    try {
      const payload = JSON.parse(raw) as { type?: string; challenge?: string; token?: string; header?: { token?: string }; event?: unknown };
      // URL verification handshake.
      if (payload.type === "url_verification") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ challenge: payload.challenge ?? "" }));
        return;
      }
      if (!this.verified(payload)) { response.writeHead(401).end(); return; }
      await this.processEvent(payload as FeishuEvent);
      response.writeHead(200).end();
    } catch {
      response.writeHead(400).end();
    }
  }

  /** Constant-time token verification when a verification token is configured. */
  private verified(payload: { token?: string; header?: { token?: string } }): boolean {
    if (this.verificationToken === null) return true;
    const presented = payload.token ?? payload.header?.token ?? "";
    const expected = Buffer.from(this.verificationToken, "utf8");
    const actual = Buffer.from(presented, "utf8");
    if (expected.length !== actual.length || expected.length === 0) return false;
    return timingSafeEqual(expected, actual);
  }
}

export { parseCommand };
