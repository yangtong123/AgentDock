import type { CodingAgent, AgentRunContext, AgentRunOutcome } from "./coding-agent.js";
import type { ProcessRunner } from "./process-runner.js";

/**
 * Environment policy: coding agents run with a controlled environment rather
 * than blindly inheriting the orchestrator's full environment, so agent
 * credentials and service secrets stay isolated.
 */
export function agentEnvironment(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}): Record<string, string> {
  const allowed = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR", "TMP", "TEMP", "SHELL", "USER", "LOGNAME", "XDG_CONFIG_HOME", "NODE_ENV"];
  const env: Record<string, string> = {};
  for (const key of allowed) if (base[key] !== undefined) env[key] = base[key]!;
  return { ...env, ...extra };
}

export interface EnvCodingAgentOptions {
  provider: string;
  binary: string;
  /** Builds argv from the context; argv is passed straight to ProcessRunner (shell disabled). */
  argv: (context: AgentRunContext) => string[];
  /** Extracts the durable session id from the raw CLI output, if the CLI emits one. */
  parseSessionId: (stdout: string, stderr: string) => string | null;
}

/** Shared argv/parse plumbing for CLI coding agents whose resume is session-id based. */
export class EnvCodingAgent implements CodingAgent {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly options: EnvCodingAgentOptions,
  ) {}

  get provider(): string { return this.options.provider; }

  async run(context: AgentRunContext): Promise<AgentRunOutcome> {
    const result = await this.runner.run({
      cwd: context.worktreePath,
      argv: this.options.argv(context),
      env: context.env,
      timeoutMs: context.timeoutMs,
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
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
      argv: (context) => [
        binary, "-p", "--output-format", "json",
        ...(context.resumeSessionId ? ["--resume", context.resumeSessionId] : []),
        "--dangerously-skip-permissions",
        context.prompt,
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
        const base = [binary, "exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox"];
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
