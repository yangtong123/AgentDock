import type { CodingAgent, AgentRunContext, AgentRunOutcome } from "./coding-agent.js";
import type { ProcessRunner } from "./process-runner.js";
import { SecretIsolation } from "../security/permissions.js";
import { OsSandbox, SandboxUnavailableError } from "./os-sandbox.js";

/**
 * Environment policy: coding agents run with a controlled environment rather
 * than blindly inheriting the orchestrator's full environment, so agent
 * credentials and service secrets stay isolated. Credential-shaped variables
 * are stripped even if allowlisted by mistake.
 */
export function agentEnvironment(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}): Record<string, string> {
  const allowed = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR", "TMP", "TEMP", "SHELL", "USER", "LOGNAME", "XDG_CONFIG_HOME", "NODE_ENV"];
  const env: Record<string, string> = {};
  for (const key of allowed) if (base[key] !== undefined) env[key] = base[key]!;
  return SecretIsolation.sanitize({ ...env, ...extra });
}

/** Claude Code's own tool policing (layer 1). acceptEdits auto-approves file
 *  edits inside the worktree; Bash is limited to git and read-only inspection.
 *  No node/npm: arbitrary node code is a network escape hatch the write jail
 *  cannot close. Web tools are denied outright. */
function claudePermissionArgs(profile: AgentRunContext["profile"]): string[] {
  if (profile.providerMode === "full-access") return ["--dangerously-skip-permissions"];
  return [
    "--permission-mode", "acceptEdits",
    "--allowedTools", "Read", "Glob", "Grep", "Edit", "Write", "NotebookEdit", "Bash(git *)", "Bash(ls *)", "Bash(grep *)", "Bash(find *)", "Bash(cat *)", "Bash(wc *)",
    "--disallowedTools", "WebFetch", "WebSearch",
  ];
}

/**
 * Codex's own sandbox (layer 1): workspace-write confines writes to the
 * worktree. network_access must stay true — it gates the Codex process's own
 * API traffic too, so false breaks the model call entirely; agent-child
 * network denial is enforced by the OS sandbox (layer 2) instead.
 */
function codexSandboxArgs(profile: AgentRunContext["profile"]): string[] {
  if (profile.providerMode === "full-access") return ["--dangerously-bypass-approvals-and-sandbox"];
  // exec mode is non-interactive: with -s workspace-write, approvals are auto-handled within the sandbox.
  return ["-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=true"];
}

export interface EnvCodingAgentOptions {
  provider: string;
  binary: string;
  /** Builds argv from the context; argv is passed straight to ProcessRunner (shell disabled). */
  argv: (context: AgentRunContext) => string[];
  /** Extracts the durable session id from the raw CLI output, if the CLI emits one. */
  parseSessionId: (stdout: string, stderr: string) => string | null;
  /** Deliver the prompt via stdin instead of a positional argument. */
  promptViaStdin?: boolean;
}

/** Shared argv/parse plumbing for CLI coding agents whose resume is session-id based. */
export class EnvCodingAgent implements CodingAgent {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly options: EnvCodingAgentOptions,
  ) {}

  get provider(): string { return this.options.provider; }

  async run(context: AgentRunContext): Promise<AgentRunOutcome> {
    // Layer 1: provider-native permission/sandbox flags. Layer 2: OS sandbox wraps the whole argv.
    // The prompt goes through stdin when promptViaStdin is set: variadic flags
    // like --allowedTools would otherwise swallow a positional prompt argument.
    const nativeArgv = this.options.argv(context);
    let plan;
    try {
      plan = OsSandbox.plan(context.profile, context.worktreePath, nativeArgv);
    } catch (error) {
      if (error instanceof SandboxUnavailableError) {
        // Fail-closed profile on an unenforceable platform: refuse as a failed step, never run unsandboxed.
        return { exitCode: 1, stdout: "", stderr: `[agentdock] ${error.message}`, externalSessionId: null, resumed: context.resumeSessionId !== null };
      }
      throw error;
    }
    const runArgs = { cwd: context.worktreePath, argv: plan.argv, env: context.env, timeoutMs: context.timeoutMs, owner: context.taskId } as const;
    const result = await this.runner.run(this.options.promptViaStdin === true ? { ...runArgs, stdin: context.prompt } : runArgs);
    return this.toOutcome(result, context, plan.fallbackReason);
  }

  private toOutcome(result: { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; cancelled: boolean }, context: AgentRunContext, fallbackReason: string | null): AgentRunOutcome {
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      // Enforcement skipped is surfaced, never silent.
      stderr: fallbackReason !== null ? `${result.stderr}\n[agentdock] OS sandbox skipped: ${fallbackReason}` : result.stderr,
      externalSessionId: this.options.parseSessionId(result.stdout, result.stderr),
      resumed: context.resumeSessionId !== null,
    };
  }
}

/** Claude Code via `claude -p`. Resume: `--resume <sessionId>`. */
export class ClaudeAgent extends EnvCodingAgent {
  constructor(runner: ProcessRunner, binary = "claude") {
    super(runner, {
      provider: "claude",
      binary,
      // The prompt travels via stdin: variadic tool flags (--allowedTools ...)
      // consume any positional argument that follows them.
      promptViaStdin: true,
      argv: (context) => [
        binary, "-p", "--output-format", "json",
        ...(context.resumeSessionId ? ["--resume", context.resumeSessionId] : []),
        ...claudePermissionArgs(context.profile),
      ],
      parseSessionId: (stdout) => { try { return JSON.parse(stdout).session_id ?? null; } catch { return null; } },
    });
  }
}

/** Codex via `codex exec`. Resume: `codex exec resume <sessionId>`. */
export class CodexAgent extends EnvCodingAgent {
  constructor(runner: ProcessRunner, binary = "codex") {
    super(runner, {
      provider: "codex",
      binary,
      argv: (context) => {
        const base = [binary, "exec", "--skip-git-repo-check", ...codexSandboxArgs(context.profile)];
        return context.resumeSessionId
          ? [...base, "resume", context.resumeSessionId, context.prompt]
          : [...base, context.prompt];
      },
      // `codex exec --json last-message` messages embed a session id header in stderr lines
      // like "session id: <uuid>"; fall back to parsing JSON output lines.
      parseSessionId: (stdout, stderr) => {
        const match = (stdout + "\n" + stderr).match(/session id[":\s]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        if (match) return match[1]!;
        for (const line of stdout.split("\n")) {
          try { const parsed = JSON.parse(line) as Record<string, unknown>; if (typeof parsed.session_id === "string") return parsed.session_id; } catch { /* not json */ }
        }
        return null;
      },
    });
  }
}
