import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, writeFileSync, writeSync } from "node:fs";
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
  /** Artifact rows created by this run (stdout/stderr logs, resume-failed captures). */
  artifacts: Artifact[];
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
    options: { resumeThreadId?: string; sessionId?: string; workflowRunId?: string; stepRunId?: string } = {},
  ): Promise<ThreadExecution> {
    const task = this.tasks.findById(input.taskId);
    if (!task) throw new NotFoundError(`Task ${input.taskId} not found`);
    if (!task.worktreePath) throw new ValidationError(`Task ${input.taskId} has no worktree; prepare it first`);
    const worktreePath = task.worktreePath;
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

    // Run/step linkage switches log capture to streaming: artifact rows (and
    // their files) exist from step start, so a live log endpoint can tail them.
    const runIds = options.workflowRunId !== undefined || options.stepRunId !== undefined
      ? { workflowRunId: options.workflowRunId ?? null, stepRunId: options.stepRunId ?? null }
      : null;
    const captured: Artifact[] = [];
    const env = agentEnvironment(this.baseEnv, { AGENTDOCK_TASK_ID: input.taskId, AGENTDOCK_ROLE: input.role });
    // The profile is the security policy for this run: provider-native flags + OS sandbox derive from it.
    const profile: PermissionProfile = resolveProfile(input.permissionProfile);
    const timeoutMs = profile.stepTimeoutMs > 0 ? Math.min(input.timeoutMs, profile.stepTimeoutMs) : input.timeoutMs;
    let outcome: AgentRunOutcome | null = null;
    let failure: ThreadExecution["failure"] = null;
    let finalStreamed = false;
    const runAttempt = async (prompt: string, resumeSessionId: string | null): Promise<AgentRunOutcome> => {
      // Only fresh attempts stream: a resume attempt that turns out to be lost
      // is captured post-hoc with the resume-failed suffix, as before.
      const stream = runIds !== null && resumeSessionId === null ? this.openStreamArtifacts(thread, runIds) : null;
      finalStreamed = stream !== null;
      try {
        const attempt = await agent.run({
          taskId: input.taskId,
          role: input.role,
          worktreePath,
          prompt,
          resumeSessionId,
          revisionRequest: input.revisionRequest,
          timeoutMs,
          env,
          profile,
          ...(stream === null ? {} : { onStdout: stream.onStdout, onStderr: stream.onStderr }),
        });
        if (stream !== null) captured.push(...stream.finish(attempt));
        return attempt;
      } catch (error) {
        stream?.abort();
        throw error;
      }
    };
    try {
      const resumeSessionId = thread.externalSessionId;
      outcome = await runAttempt(input.prompt, resumeSessionId);
      // Session loss fallback: resume produced no usable session — retry fresh with durable context.
      if (resumeSessionId !== null && outcome.externalSessionId === null && (outcome.exitCode ?? 1) !== 0) {
        captured.push(...this.captureArtifacts(thread, outcome, "resume-failed", runIds));
        outcome = await runAttempt(`${input.revisionRequest}\n\n${input.prompt}`, null);
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
    if (outcome && !finalStreamed) captured.push(...this.captureArtifacts(thread, outcome, undefined, runIds));
    if (!failure && outcome && (outcome.exitCode ?? 1) !== 0) {
      failure = { kind: "NON_ZERO_EXIT", message: `agent exited with code ${outcome.exitCode}` };
    }
    return { thread, outcome, failure, artifacts: captured };
  }

  /** Creates stdout/stderr artifact rows up front and appends process chunks as they arrive. */
  private openStreamArtifacts(thread: AgentThread, runIds: { workflowRunId: string | null; stepRunId: string | null }): {
    onStdout: (chunk: string) => void;
    onStderr: (chunk: string) => void;
    finish: (outcome: AgentRunOutcome) => Artifact[];
    abort: () => void;
  } {
    const recordedAt = this.now();
    const streams = (["agent-stdout", "agent-stderr"] as const).map((kind) => {
      const path = join(this.artifactRoot, thread.id, `${kind}.txt`);
      mkdirSync(dirname(path), { recursive: true });
      const artifact = this.artifacts.create({ id: randomUUID(), taskId: thread.taskId, workflowRunId: runIds.workflowRunId, stepRunId: runIds.stepRunId, kind, name: `${thread.provider}-${thread.role}-${kind}`, storage: { type: "FILE", path }, createdAt: recordedAt });
      return { kind, artifact, fd: openSync(path, "a"), streamed: 0 };
    });
    const sink = (kind: "agent-stdout" | "agent-stderr") => (chunk: string) => {
      const entry = streams.find((s) => s.kind === kind)!;
      writeSync(entry.fd, chunk);
      entry.streamed += chunk.length;
    };
    const close = (): void => { for (const entry of streams) closeSync(entry.fd); };
    return {
      onStdout: sink("agent-stdout"),
      onStderr: sink("agent-stderr"),
      finish: (outcome) => {
        // Agents that never invoke the stream callbacks (in-process fakes)
        // still get their output persisted, like the pre-streaming capture did.
        for (const entry of streams) {
          const content = entry.kind === "agent-stdout" ? outcome.stdout : outcome.stderr;
          if (entry.streamed === 0 && content !== "") writeSync(entry.fd, content);
        }
        close();
        return streams.map((s) => s.artifact);
      },
      abort: close,
    };
  }

  private captureArtifacts(thread: AgentThread, outcome: AgentRunOutcome, label?: string, runIds: { workflowRunId: string | null; stepRunId: string | null } | null = null): Artifact[] {
    const recordedAt = this.now();
    const suffix = label ? `-${label}` : "";
    const created: Artifact[] = [];
    const persist = (kind: string, name: string, content: string): void => {
      // stdout/stderr go to FILE storage — agent transcripts are too large for the DB row.
      const path = join(this.artifactRoot, thread.id, `${kind}${suffix}.txt`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, "utf8");
      created.push(this.artifacts.create({ id: randomUUID(), taskId: thread.taskId, workflowRunId: runIds?.workflowRunId ?? null, stepRunId: runIds?.stepRunId ?? null, kind, name: `${thread.provider}-${thread.role}-${kind}${suffix}`, storage: { type: "FILE", path }, createdAt: recordedAt }));
    };
    if (outcome.stdout) persist("agent-stdout", "stdout", outcome.stdout);
    if (outcome.stderr) persist("agent-stderr", "stderr", outcome.stderr);
    return created;
  }
}
