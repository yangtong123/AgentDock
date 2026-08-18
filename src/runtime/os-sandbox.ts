import type { OsSandboxMode, PermissionProfile } from "../security/permissions.js";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

export interface SandboxPlan {
  /** Effective mode after platform/capability resolution. */
  mode: OsSandboxMode;
  /** Mechanism actually used: informative for audit and stderr notes. */
  mechanism: "none" | "seatbelt" | "bwrap";
  /** Wrapped argv; identical to input when mechanism is none. */
  argv: string[];
  /** Set when enforcement was skipped (failClosed=false profiles only). */
  fallbackReason: string | null;
}

/** Raised when a fail-closed profile cannot be enforced on this platform. */
export class SandboxUnavailableError extends Error {
  constructor(reason: string) { super(`OS sandbox unavailable: ${reason}`); this.name = "SandboxUnavailableError"; }
}

/**
 * Layer-2 OS sandbox: wraps agent argv with sandbox-exec (macOS Seatbelt) or
 * bwrap (Linux) so a compromised agent cannot write outside its worktree —
 * regardless of what the agent CLI itself allows. The profile declares the
 * platform-neutral "write-jail" intent; plan() resolves it to a mechanism.
 * Profiles marked failClosed refuse to run when no mechanism exists instead
 * of silently executing unsandboxed.
 */
export class OsSandbox {
  private static bwrapAvailable: boolean | null = null;

  /** Test seam: override the bwrap capability probe. */
  static setBwrapAvailable(available: boolean | null): void { OsSandbox.bwrapAvailable = available; }

  /** Resolves the plan for one agent invocation. Throws SandboxUnavailableError when fail-closed and unenforceable. */
  static plan(profile: PermissionProfile, worktreePath: string, argv: string[], options: { bwrapAvailable?: boolean; extraReadPaths?: string[] } = {}): SandboxPlan {
    if (profile.osSandbox === "none") return { mode: "none", mechanism: "none", argv, fallbackReason: null };

    if (process.platform === "darwin") {
      return { mode: "write-jail", mechanism: "seatbelt", argv: ["sandbox-exec", "-p", this.seatbeltProfile(profile, worktreePath), "--", ...argv], fallbackReason: null };
    }

    const bwrapAvailable = options.bwrapAvailable ?? this.detectBwrap();
    if (bwrapAvailable) {
      return { mode: "write-jail", mechanism: "bwrap", argv: this.bwrapArgv(profile, worktreePath, argv, options.extraReadPaths ?? []), fallbackReason: null };
    }

    const reason = `write-jail requested but no mechanism exists on ${process.platform} (install bubblewrap)`;
    if (profile.failClosed) throw new SandboxUnavailableError(reason);
    return { mode: "none", mechanism: "none", argv, fallbackReason: reason };
  }

  /**
   * Seatbelt profile: writes confined to the worktree, tmp, and the agent
   * CLIs' own state dirs (~/.claude, ~/.codex) — minus codex's config.toml,
   * which stays read-only so a compromised agent cannot plant MCP servers or
   * model settings that would persist into future runs (Seatbelt denies win
   * over allows). Network is NOT denied here: the agent CLI's own model-API
   * traffic would break, and Seatbelt cannot distinguish it from
   * child-process traffic. Paths are realpath-normalized because Seatbelt
   * matches literal prefixes — /tmp vs /private/tmp mismatches would
   * silently deny legitimate writes.
   *
   * Deliberately no mach-lookup allowances: macOS system brokers (trustd,
   * securityd/SecurityServer, configd, ...) would give a compromised agent
   * XPC access to credential-adjacent services. Runtimes that need system
   * trust for TLS (codex/rustls) get a file-based root bundle via
   * SSL_CERT_FILE instead — see CodexAgent.
   */
  static seatbeltProfile(profile: PermissionProfile, worktreePath: string): string {
    const home = process.env.HOME ?? "/Users/unknown";
    const writePaths = [
      worktreePath,
      "/private/tmp",
      "/tmp",
      `${home}/.claude`,
      `${home}/.codex`,
      ...(profile.extraReadPaths ?? []),
    ].map((path) => this.normalize(path));
    const writeRules = writePaths.map((path) => `  (allow file-write* (subpath "${this.escape(path)}"))`).join("\n");
    return `(version 1)
(deny default)
(allow process-exec*)
(allow process-fork)
(allow sysctl-read)
(allow file-read*)
(allow network*)
${writeRules}
  ;; SBPL: later rules win — the config-file deny must come after the allows.
  (deny file-write* (literal "${this.escape(this.normalize(`${home}/.codex/config.toml`))}"))
`;
  }

  static bwrapArgv(profile: PermissionProfile, worktreePath: string, argv: string[], extraReadPaths: string[] = []): string[] {
    const home = process.env.HOME ?? "/home/unknown";
    const args = [
      "bwrap",
      // Runtime filesystem: dynamic linkers live in /lib,/lib64 (often symlinks
      // into /usr, but not always); /etc carries CA certs, DNS, passwd, nsswitch.
      // Without these, node/git/claude/codex die on the first exec or TLS call.
      "--ro-bind", "/usr", "/usr",
      "--ro-bind-try", "/lib", "/lib",
      "--ro-bind-try", "/lib64", "/lib64",
      "--ro-bind-try", "/bin", "/bin",
      "--ro-bind-try", "/sbin", "/sbin",
      "--ro-bind", "/etc", "/etc",
      "--proc", "/proc",
      "--dev", "/dev",
      "--tmpfs", "/tmp",
      "--bind", worktreePath, worktreePath,
      // Config dirs only when they exist: --ro-bind fails hard on missing paths.
      "--ro-bind-try", `${home}/.claude`, `${home}/.claude`,
      "--ro-bind-try", `${home}/.codex`, `${home}/.codex`,
      "--ro-bind-try", `${home}/.config`, `${home}/.config`,
      "--setenv", "HOME", home,
    ];
    for (const path of profile.extraReadPaths ?? []) args.push("--ro-bind-try", path, path);
    // Per-invocation extras (e.g. a custom SSL_CERT_FILE outside /etc): the
    // file would otherwise be invisible inside the namespace.
    for (const path of extraReadPaths) args.push("--ro-bind-try", path, path);
    // Network stays up: --unshare-net would also kill the agent's model-API traffic.
    args.push("--", ...argv);
    return args;
  }

  /** realpath with a fallback for paths that do not exist yet (worktrees are created before first run). */
  private static normalize(path: string): string {
    try { return realpathSync(path); } catch { return path; }
  }

  private static escape(path: string): string {
    // Seatbelt string literals: escape backslash and double quote.
    return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  private static detectBwrap(): boolean {
    if (OsSandbox.bwrapAvailable !== null) return OsSandbox.bwrapAvailable;
    // `bwrap --version` only proves the binary exists. Run a real namespace
    // smoke test: user-namespace creation can be blocked (AppArmor, sysctl)
    // even when the binary runs. /bin vs /usr/bin varies across distros.
    for (const trueBinary of ["/bin/true", "/usr/bin/true"]) {
      try {
        execFileSync("bwrap", ["--ro-bind", "/", "/", "--", trueBinary], { stdio: "ignore", timeout: 10_000 });
        OsSandbox.bwrapAvailable = true;
        return true;
      } catch { /* try the next location */ }
    }
    OsSandbox.bwrapAvailable = false;
    return false;
  }
}
