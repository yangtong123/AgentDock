import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentThread, Artifact } from "../shared/domain.js";
import type { AgentThreadRepository } from "../agents/agent-thread-repository.js";
import type { ArtifactRepository } from "../artifacts/artifact-repository.js";
import type { TaskRepository } from "../tasks/task-repository.js";
import type { CodingAgent, AgentRunOutcome } from "./coding-agent.js";
import { NotFoundError, ValidationError } from "../shared/domain.js";
import { ProcessTimeoutError, ProcessCancelledError } from "./process-runner.js";
import { agentEnvironment } from "./env-agents.js";
import { resolveProfile, type PermissionProfile } from "../security/permissions.js";

export interface StartThreadInput {
  taskId: string;
  role: string;
  prompt: string;
  revisionRequest: string;
  timeoutMs: number;
  /** Project's permission profile name; defaults to "default". */
  permissionProfile?: string | null;
}

export interface ThreadExecution {
  thread: AgentThread;
  outcome: AgentRunOutcome | null;
  failure: { kind: "TIMEOUT" | "CANCELLED" | "NON_ZERO_EXIT"; message: string } | null;
}

/**
 * Owns AgentThread lifecycle: start (fresh session), resume (by external
 * session id), and session-loss fallback. Agent session history is an
 * optimization — when the external session id is missing or a resume fails,
 * the thread re-runs with the durable revision request so the task context
 * survives session loss.
 */
export class AgentThreadManager {
  constructor(
    private readonly threads: AgentThreadRepository,
    private readonly artifacts: ArtifactRepository,
    private readonly tasks: TaskRepository,
    private readonly resolveAgent: (provider: string) => CodingAgent,
    private readonly artifactRoot: string,
    private readonly now = () => new Date().toISOString(),
    private readonly baseEnv: NodeJS.ProcessEnv = process.env,
  ) {}

  async run(
    input: StartThreadInput,
    provider: string,
    options: { resumeThreadId?: string; sessionId?: string } = {},
  ): Promise<ThreadExecution> {
    const task = this.tasks.findById(input.taskId);
    if (!task) throw new NotFoundError(`Task ${input.taskId} not found`);
    if (!task.worktreePath) throw new ValidationError(`Task ${input.taskId} has no worktree; prepare it first`);
    const agent = this.resolveAgent(provider);

    let thread: AgentThread;
    if (options.resumeThreadId) {
      const existing = this.threads.findById(options.resumeThreadId);
      if (!existing) throw new NotFoundError(`AgentThread ${options.resumeThreadId} not found`);
      thread = existing;
    } else {
      const timestamp = this.now();
      thread = { id: randomUUID(), taskId: input.taskId, provider: agent.provider, role: input.role, externalSessionId: options.sessionId ?? null, createdAt: timestamp, updatedAt: timestamp };
      this.threads.create(thread);
    }
    if (options.sessionId !== undefined && options.sessionId !== thread.externalSessionId) {
      thread = { ...thread, externalSessionId: options.sessionId, updatedAt: this.now() };
      this.threads.updateSessionId(thread.id, options.sessionId, thread.updatedAt);
    }

    const env = agentEnvironment(this.baseEnv, { AGENTDOCK_TASK_ID: input.taskId, AGENTDOCK_ROLE: input.role });
    // The profile is the security policy for this run: provider-native flags + OS sandbox derive from it.
    const profile: PermissionProfile = resolveProfile(input.permissionProfile);
    let outcome: AgentRunOutcome | null = null;
    let failure: ThreadExecution["failure"] = null;
    try {
      outcome = await agent.run({
        taskId: input.taskId,
        role: input.role,
        worktreePath: task.worktreePath,
        prompt: input.prompt,
        resumeSessionId: thread.externalSessionId,
        revisionRequest: input.revisionRequest,
        timeoutMs: profile.stepTimeoutMs > 0 ? Math.min(input.timeoutMs, profile.stepTimeoutMs) : input.timeoutMs,
        env,
        profile,
      });
      // Session loss fallback: resume produced no usable session — retry fresh with durable context.
      if (thread.externalSessionId && outcome.externalSessionId === null && (outcome.exitCode ?? 1) !== 0) {
        this.captureArtifacts(thread, outcome, "resume-failed");
        outcome = await agent.run({
          taskId: input.taskId, role: input.role, worktreePath: task.worktreePath,
          prompt: `${input.revisionRequest}\n\n${input.prompt}`,
          resumeSessionId: null, revisionRequest: input.revisionRequest,
          timeoutMs: profile.stepTimeoutMs > 0 ? Math.min(input.timeoutMs, profile.stepTimeoutMs) : input.timeoutMs, env, profile,
        });
      }
    } catch (error) {
      if (error instanceof ProcessTimeoutError) failure = { kind: "TIMEOUT", message: `agent timed out after ${input.timeoutMs}ms` };
      else if (error instanceof ProcessCancelledError) failure = { kind: "CANCELLED", message: "agent run was cancelled" };
      else throw error;
    }

    if (outcome && outcome.externalSessionId && outcome.externalSessionId !== thread.externalSessionId) {
      const externalSessionId = outcome.externalSessionId;
      thread = { ...thread, externalSessionId, updatedAt: this.now() };
      this.threads.updateSessionId(thread.id, externalSessionId, thread.updatedAt);
    }
    if (outcome) this.captureArtifacts(thread, outcome);
    if (!failure && outcome && (outcome.exitCode ?? 1) !== 0) {
      failure = { kind: "NON_ZERO_EXIT", message: `agent exited with code ${outcome.exitCode}` };
    }
    return { thread, outcome, failure };
  }

  private captureArtifacts(thread: AgentThread, outcome: AgentRunOutcome, label?: string): void {
    const recordedAt = this.now();
    const suffix = label ? `-${label}` : "";
    const persist = (kind: string, name: string, content: string): void => {
      // stdout/stderr go to FILE storage — agent transcripts are too large for the DB row.
      const path = join(this.artifactRoot, thread.id, `${kind}${suffix}.txt`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, "utf8");
      this.artifacts.create({ id: randomUUID(), taskId: thread.taskId, workflowRunId: null, stepRunId: null, kind, name: `${thread.provider}-${thread.role}-${kind}${suffix}`, storage: { type: "FILE", path }, createdAt: recordedAt });
    };
    if (outcome.stdout) persist("agent-stdout", "stdout", outcome.stdout);
    if (outcome.stderr) persist("agent-stderr", "stderr", outcome.stderr);
  }
}
