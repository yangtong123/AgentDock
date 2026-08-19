import type { CodingAgent, AgentRunContext, AgentRunOutcome } from "./coding-agent.js";
import type { ProcessRunner } from "./process-runner.js";
import { existsSync } from "node:fs";
import { SecretIsolation } from "../security/permissions.js";
import { OsSandbox, SandboxUnavailableError } from "./os-sandbox.js";

const PROXY_VARS = ["http_proxy", "https_proxy", "all_proxy", "no_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"];

/** Strips proxy userinfo from every proxy variable in env, in place-ish (returns the cleaned copy). */
function sanitizeProxyValues(env: Record<string, string>): Record<string, string> {
  const cleaned = { ...env };
  for (const key of PROXY_VARS) {
    const value = cleaned[key];
    if (value === undefined) continue;
    const sanitized = stripProxyUserinfo(value);
    if (sanitized === undefined) delete cleaned[key];
    else cleaned[key] = sanitized;
  }
  return cleaned;
}

/**
 * Environment policy: coding agents run with a controlled environment rather
 * than blindly inheriting the orchestrator's full environment, so agent
 * credentials and service secrets stay isolated. Credential-shaped variables
 * are stripped even if allowlisted by mistake.
 */
export function agentEnvironment(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}): Record<string, string> {
  const allowed = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR", "TMP", "TEMP", "SHELL", "USER", "LOGNAME", "XDG_CONFIG_HOME", "NODE_ENV", "SSL_CERT_FILE"];
  // Proxy settings are not credentials and many networks require them to
  // reach model APIs at all — strip them and the agent CLI retries forever.
  const env: Record<string, string> = {};
  for (const key of allowed) if (base[key] !== undefined) env[key] = base[key]!;
  // Sanitize proxy values AFTER merging base and extra: an extra proxy var
  // must not bypass credential stripping.
  const merged = { ...env };
  for (const key of PROXY_VARS) if (base[key] !== undefined) merged[key] = base[key]!;
  Object.assign(merged, extra);
  return SecretIsolation.sanitize(sanitizeProxyValues(merged));
}

/**
 * Proxy URLs may carry credentials in the userinfo (`http://user:pass@host`).
 * Agents need the proxy, not its password. Parse with WHATWG URL and clear
 * the credentials; when the value contains "@" but no credentials were
 * parsed out (opaque scheme, schemeless "//user@host", unparseable), the "@"
 * is ambiguous and the value is rejected — fail closed. Returns undefined for
 * rejected values.
 */
export function stripProxyUserinfo(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value.includes("@") ? undefined : value;
  }
  if (url.username === "" && url.password === "" && value.includes("@")) return undefined;
  url.username = "";
  url.password = "";
  return url.toString();
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
 * Codex's own sandbox (layer 1) cannot nest inside the OS write-jail (layer
 * 2): macOS denies the inner sandbox_apply, and codex then rejects every
 * filesystem operation — including worktree writes. So when layer 2 is
 * enforced (any write-jail profile, fail-closed by design), codex runs with
 * its provider-native sandbox off and layer 2 alone confines writes to the
 * worktree. The network flag from the workspace-write mode is unnecessary
 * for the same reason: codex's own API traffic needs the network anyway.
 */
function codexSandboxArgs(profile: AgentRunContext["profile"]): string[] {
  if (profile.providerMode === "full-access") return ["--dangerously-bypass-approvals-and-sandbox"];
  if (profile.osSandbox !== "none" && profile.failClosed) return ["-s", "danger-full-access"];
  // No enforced OS jail (custom/degraded profile): fall back to codex's own workspace-write.
  return ["-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=true"];
}

export interface EnvCodingAgentOptions {
  provider: string;
  binary: string;
  /** Builds argv from the context; argv is passed straight to ProcessRunner (shell disabled). */
  argv: (context: AgentRunContext) => string[];
  /** Extra environment variables for this provider, merged over the base agent env. */
  envExtra?: (context: AgentRunContext) => Record<string, string>;
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
    // envExtra merges before screening, never after: provider-injected
    // variables get the same credential and proxy-userinfo screening as
    // everything else.
    const env = SecretIsolation.sanitize(sanitizeProxyValues({ ...context.env, ...(this.options.envExtra?.(context) ?? {}) }));
    let plan;
    try {
      // A custom CA bundle outside /etc must stay visible inside bwrap.
      plan = OsSandbox.plan(context.profile, context.worktreePath, nativeArgv, { extraReadPaths: env.SSL_CERT_FILE !== undefined ? [env.SSL_CERT_FILE] : [] });
    } catch (error) {
      if (error instanceof SandboxUnavailableError) {
        // Fail-closed profile on an unenforceable platform: refuse as a failed step, never run unsandboxed.
        return { exitCode: 1, stdout: "", stderr: `[agentdock] ${error.message}`, externalSessionId: null, resumed: context.resumeSessionId !== null };
      }
      throw error;
    }
    const runArgs = { cwd: context.worktreePath, argv: plan.argv, env, timeoutMs: context.timeoutMs, owner: context.taskId, ...(context.onStdout !== undefined ? { onStdout: context.onStdout } : {}), ...(context.onStderr !== undefined ? { onStderr: context.onStderr } : {}) } as const;
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

/**
 * First existing well-known CA bundle path, or null. Codex (rustls) uses it
 * via SSL_CERT_FILE so TLS never needs macOS trustd/securityd XPC, which the
 * Seatbelt write-jail denies. Candidates cover macOS/Homebrew, Debian/Ubuntu,
 * and RHEL/Fedora layouts.
 */
export function defaultCaBundlePath(candidates: string[] = ["/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/cert.pem"]): string | null {
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return null;
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
      // Codex (rustls) verifies TLS through macOS trustd/securityd XPC, which
      // the Seatbelt write-jail denies — the handshake then fails and the CLI
      // retries until the step timeout. Pointing rustls at a file-based root
      // bundle keeps the sandbox free of any keychain/system-broker access.
      // Node CLIs (claude) ship compiled-in roots and need nothing. Only
      // write-jail profiles need this: full-access runs unsandboxed, where the
      // system trust chain (including enterprise Keychain CAs) works as-is,
      // and a user-provided SSL_CERT_FILE always wins.
      envExtra: (context) => {
        if (context.profile.osSandbox === "none") return {};
        if (context.env.SSL_CERT_FILE !== undefined) return {};
        const bundle = defaultCaBundlePath();
        return bundle !== null ? { SSL_CERT_FILE: bundle } : {};
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
