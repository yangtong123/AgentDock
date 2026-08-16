import type { ProcessRunner } from "./process-runner.js";

/** Context handed to a coding agent for one step execution. */
export interface AgentRunContext {
  taskId: string;
  /** Workflow step type this run serves (PLAN, IMPLEMENT, REVIEW, ...). */
  role: string;
  worktreePath: string;
  prompt: string;
  /** External session id from a previous step of the same thread, if resuming. */
  resumeSessionId: string | null;
  /** Revision context durable in AgentDock, used when a session is lost. */
  revisionRequest: string;
  timeoutMs: number;
  env: Record<string, string>;
}

export interface AgentRunOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  externalSessionId: string | null;
  resumed: boolean;
}

/**
 * Provider-neutral coding agent abstraction. Implementations translate run()
 * into their CLI's argv form. Roles and providers are decoupled: the workflow
 * engine picks a provider per step; nothing here assumes which is planner or
 * implementer.
 */
export interface CodingAgent {
  readonly provider: string;
  run(context: AgentRunContext): Promise<AgentRunOutcome>;
}
