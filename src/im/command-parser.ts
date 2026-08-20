import type { ImCommand } from "./im-adapter.js";
import { STEP_TYPES } from "../shared/domain.js";

/** Presets accepted by /run — kept in lockstep with expandPreset (tested). */
export const IM_RUN_PRESETS = ["fast", "cross-review", "careful", "fix"] as const;

/**
 * Parses IM text into domain commands. User text becomes command *data*
 * (e.g. a task request) and is never concatenated into shell commands.
 * Returns null for non-command chat.
 *
 * /run accepts per-step provider assignments:
 *   /run TASK_ID PRESET [STEP=provider ...]
 * Provider names are validated by the controller (it knows the registered
 * agents); the parser validates step types and token shape only.
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
    case "/providers":
      return { type: "LIST_PROVIDERS", conversationId };
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
      if (!(IM_RUN_PRESETS as readonly string[]).includes(preset)) return null;
      const providers: Record<string, string> = {};
      for (const token of parts.slice(2)) {
        const [step, provider, extra] = token.split("=");
        if (extra !== undefined || !step || !provider) return null;
        if (!(STEP_TYPES as readonly string[]).includes(step)) return null;
        if (providers[step] !== undefined) return null; // duplicate STEP= tokens are an error, not last-win
        providers[step] = provider;
      }
      return Object.keys(providers).length === 0
        ? { type: "RUN_TASK", conversationId, taskId, preset }
        : { type: "RUN_TASK", conversationId, taskId, preset, providers };
    }
    case "/tasks":
      return { type: "LIST_TASKS", conversationId };
    case "/status":
      if (!argument) return null;
      return { type: "TASK_STATUS", conversationId, taskId: argument };
    case "/stop":
      if (!argument) return null;
      return { type: "STOP_TASK", conversationId, taskId: argument };
    case "/watch":
    case "/subscribe":
      if (!argument) return null;
      return { type: "WATCH_TASK", conversationId, taskId: argument };
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
