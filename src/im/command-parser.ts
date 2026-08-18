import type { ImCommand } from "./im-adapter.js";

/**
 * Parses IM text into domain commands. User text becomes command *data*
 * (e.g. a task request) and is never concatenated into shell commands.
 * Returns null for non-command chat.
 */
export function parseCommand(conversationId: string, text: string): ImCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const [rawCommand, ...rest] = trimmed.split(/\s+/);
  const command = rawCommand!.split("@")[0]!; // tolerate /cmd@botname
  const argument = rest.join(" ");

  switch (command) {
    case "/projects":
    case "/start":
      return { type: "LIST_PROJECTS", conversationId };
    case "/use":
      if (!argument) return null;
      return { type: "USE_PROJECT", conversationId, projectName: argument };
    case "/new":
      if (!argument) return null;
      return { type: "CREATE_TASK", conversationId, request: argument };
    case "/run": {
      const parts = rest.filter((part) => part !== "");
      if (parts.length < 2) return null;
      const taskId = parts[0]!;
      const preset = parts[1]!;
      if (preset !== "fast" && preset !== "cross-review" && preset !== "careful") return null;
      return { type: "RUN_TASK", conversationId, taskId, preset };
    }
    case "/tasks":
      return { type: "LIST_TASKS", conversationId };
    case "/status":
      if (!argument) return null;
      return { type: "TASK_STATUS", conversationId, taskId: argument };
    case "/stop":
      if (!argument) return null;
      return { type: "STOP_TASK", conversationId, taskId: argument };
    case "/approve": {
      const runId = rest[0] ?? "";
      if (!runId) return null;
      return { type: "APPROVE_RUN", conversationId, runId, approved: true };
    }
    case "/reject": {
      const runId = rest[0] ?? "";
      if (!runId) return null;
      return { type: "APPROVE_RUN", conversationId, runId, approved: false };
    }
    case "/diff": {
      if (!argument) return null;
      const parts = rest.filter((part) => part !== "--stat");
      if (parts.length === 0) return null;
      return { type: "VIEW_DIFF", conversationId, taskId: parts.join(" "), statOnly: rest.includes("--stat") };
    }
    default:
      return null;
  }
}
