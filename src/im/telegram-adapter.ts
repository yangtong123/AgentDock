import type { ImAdapter, ImCommand, ImMessage, ImReply } from "./im-adapter.js";
import { parseCommand } from "./command-parser.js";

type MessageHandler = (message: ImMessage) => Promise<void>;
type ActionHandler = (command: ImCommand) => Promise<void>;

const MAX_CALLBACK_DATA_BYTES = 64;

/** Compact callback payloads: Telegram caps callback_data at 64 bytes, so JSON commands don't fit. */
export function encodeCallback(command: ImCommand): string | null {
  switch (command.type) {
    case "APPROVE_RUN": return `ar:${command.runId}:${command.approved ? "1" : "0"}`;
    case "STOP_TASK": return command.taskId.length + 8 <= MAX_CALLBACK_DATA_BYTES ? `st:${command.taskId}` : null;
    case "CONTINUE_RUN": return `cr:${command.runId}`;
    default: return null;
  }
}

/** Reverses encodeCallback; only whitelisted shapes are accepted. Returns null for anything else. */
export function decodeCallback(data: string, conversationId: string): ImCommand | null {
  const [prefix, a, b] = data.split(":");
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (prefix === "ar" && a && b !== undefined) {
    if (!uuidPattern.test(a) || (b !== "0" && b !== "1")) return null;
    return { type: "APPROVE_RUN", conversationId, runId: a, approved: b === "1" };
  }
  if (prefix === "st" && a) {
    if (!uuidPattern.test(a)) return null;
    return { type: "STOP_TASK", conversationId, taskId: a };
  }
  if (prefix === "cr" && a) {
    if (!uuidPattern.test(a)) return null;
    return { type: "CONTINUE_RUN", conversationId, runId: a };
  }
  return null;
}

/**
 * Adapter for long-polling Telegram bots. Translates updates into ImCommands
 * via the shared parser and sends replies through the Bot API. No domain
 * logic lives here: handlers only create commands. Access is restricted to
 * allowlisted chat ids when ALLOWED_CHAT_IDS is set.
 */
export class TelegramAdapter implements ImAdapter {
  readonly name = "telegram";
  private messageHandler: MessageHandler | null = null;
  private actionHandler: ActionHandler | null = null;
  private stopped = false;
  private offset = 0;
  private readonly allowedChatIds: Set<string>;

  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly pollTimeoutMs = 30_000,
    allowedChatIds: string[] | string | null = null,
  ) {
    if (!token.trim()) throw new Error("Telegram bot token is required");
    const raw = allowedChatIds ?? process.env.ALLOWED_CHAT_IDS ?? null;
    this.allowedChatIds = new Set(raw === null ? [] : (typeof raw === "string" ? raw.split(",").map((id) => id.trim()).filter(Boolean) : raw));
  }

  onMessage(handler: MessageHandler): void { this.messageHandler = handler; }
  onAction(handler: ActionHandler): void { this.actionHandler = handler; }

  async start(): Promise<void> {
    this.stopped = false;
    void this.pollLoop();
  }

  async stop(): Promise<void> { this.stopped = true; }

  async send(reply: ImReply): Promise<void> {
    await this.call("sendMessage", {
      chat_id: reply.conversationId,
      text: reply.text,
      ...(reply.actions ? { reply_markup: this.keyboardFor(reply) } : {}),
    });
  }

  private keyboardFor(reply: ImReply): Record<string, unknown> {
    const rows: { text: string; callback_data: string }[][] = [];
    for (const action of reply.actions ?? []) {
      const encoded = encodeCallback(action.command);
      if (encoded !== null) rows.push([{ text: action.label, callback_data: encoded }]);
    }
    return { inline_keyboard: rows };
  }

  private authorize(conversationId: string): boolean {
    return this.allowedChatIds.size === 0 || this.allowedChatIds.has(conversationId);
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopped) {
      let updates: { update_id: number; message?: { chat: { id: number }; text?: string }; callback_query?: { id: string; data?: string; message?: { chat: { id: number } } } }[] = [];
      try {
        updates = await this.call("getUpdates", { offset: this.offset, timeout: Math.floor(this.pollTimeoutMs / 1000) }) as typeof updates;
      } catch {
        if (!this.stopped) await new Promise((resolve) => setTimeout(resolve, 3000));
        continue;
      }
      for (const update of updates) {
        // Process fully before advancing: one bad update must not drop the rest of the batch.
        try { await this.processUpdate(update); } catch { /* skip malformed update */ }
        this.offset = update.update_id + 1;
      }
    }
  }

  private async processUpdate(update: { message?: { chat: { id: number }; text?: string }; callback_query?: { id: string; data?: string; message?: { chat: { id: number } } } }): Promise<void> {
    if (update.message?.text !== undefined) {
      const conversationId = String(update.message.chat.id);
      if (!this.authorize(conversationId)) return;
      await this.messageHandler?.({ conversationId, text: update.message.text });
    } else if (update.callback_query?.data !== undefined) {
      const conversationId = update.callback_query.message?.chat.id !== undefined ? String(update.callback_query.message.chat.id) : "";
      if (conversationId === "" || !this.authorize(conversationId)) return;
      const command = decodeCallback(update.callback_query.data, conversationId);
      // answerCallbackQuery regardless: the client spinner must clear even for rejected payloads.
      void this.call("answerCallbackQuery", { callback_query_id: update.callback_query.id }).catch(() => undefined);
      if (command) await this.actionHandler?.(command);
    }
  }

  private async call(method: string, payload: Record<string, unknown>): Promise<unknown> {
    const response = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.pollTimeoutMs + 10_000),
    });
    if (!response.ok) throw new Error(`Telegram ${method} failed: ${response.status}`);
    const body = await response.json() as { ok: boolean; result?: unknown; description?: string };
    if (!body.ok) throw new Error(`Telegram ${method} error: ${body.description ?? "unknown"}`);
    return body.result;
  }
}

export { parseCommand };
