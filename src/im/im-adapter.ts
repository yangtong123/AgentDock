import type { StepType } from "../shared/domain.js";

/** Domain-level commands created by IM adapters. Handlers never run agents or shell commands directly. */
export type ImCommand =
  | { type: "LIST_PROJECTS"; conversationId: string }
  | { type: "LIST_PROVIDERS"; conversationId: string }
  | { type: "USE_PROJECT"; conversationId: string; projectName: string }
  | { type: "CREATE_TASK"; conversationId: string; request: string }
  | { type: "RUN_TASK"; conversationId: string; taskId: string; preset: string; providers?: Record<string, string> }
  | { type: "LIST_TASKS"; conversationId: string }
  | { type: "TASK_STATUS"; conversationId: string; taskId: string }
  | { type: "STOP_TASK"; conversationId: string; taskId: string }
  | { type: "APPROVE_RUN"; conversationId: string; runId: string; approved: boolean }
  | { type: "CONTINUE_RUN"; conversationId: string; runId: string }
  | { type: "VIEW_DIFF"; conversationId: string; taskId: string; statOnly: boolean };

export interface ImMessage {
  /** Stable conversation identity; tasks belong to AgentDock, not to one IM conversation. */
  conversationId: string;
  text: string;
}

export interface ImReply {
  conversationId: string;
  text: string;
  /** Optional interactive actions attached to the reply (approve/reject buttons, etc.). */
  actions?: ImAction[];
}

export interface ImAction {
  label: string;
  command: ImCommand;
}

/**
 * Port for chat systems. Adapters translate platform updates into ImCommands
 * and deliver ImReply payloads; all domain logic stays in the controller.
 */
export interface ImAdapter {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(reply: ImReply): Promise<void>;
  /** Registers the handler that turns inbound messages into commands. */
  onMessage(handler: (message: ImMessage) => Promise<void>): void;
  onAction(handler: (command: ImCommand) => Promise<void>): void;
}

export interface CommandQueue {
  enqueue(command: ImCommand): Promise<void>;
  dequeue(): Promise<ImCommand | null>;
  size(): number;
}
