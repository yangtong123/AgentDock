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
  static plan(profile: PermissionProfile, worktreePath: string, argv: string[], options: { bwrapAvailable?: boolean } = {}): SandboxPlan {
    if (profile.osSandbox === "none") return { mode: "none", mechanism: "none", argv, fallbackReason: null };

    if (process.platform === "darwin") {
      return { mode: "write-jail", mechanism: "seatbelt", argv: ["sandbox-exec", "-p", this.seatbeltProfile(profile, worktreePath), "--", ...argv], fallbackReason: null };
    }

    const bwrapAvailable = options.bwrapAvailable ?? this.detectBwrap();
    if (bwrapAvailable) {
      return { mode: "write-jail", mechanism: "bwrap", argv: this.bwrapArgv(profile, worktreePath, argv), fallbackReason: null };
    }

    const reason = `write-jail requested but no mechanism exists on ${process.platform} (install bubblewrap)`;
    if (profile.failClosed) throw new SandboxUnavailableError(reason);
    return { mode: "none", mechanism: "none", argv, fallbackReason: reason };
  }

  /**
   * Seatbelt profile: writes confined to the worktree, agent config/cache dirs
   * (~/.claude, ~/.codex), and tmp. Everything else is read-only. Network is
   * NOT denied here: the agent CLI's own model-API traffic would break, and
   * Seatbelt cannot distinguish it from child-process traffic. Paths are
   * realpath-normalized because Seatbelt matches literal prefixes — /tmp vs
   * /private/tmp mismatches would silently deny legitimate writes.
   */
  static seatbeltProfile(profile: PermissionProfile, worktreePath: string): string {
    const home = process.env.HOME ?? "/Users/unknown";
    const writePaths = [
      worktreePath,
      `${home}/.claude`,
      `${home}/.codex`,
      `${home}/.config`,
      "/private/tmp",
      "/tmp",
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
`;
  }

  static bwrapArgv(profile: PermissionProfile, worktreePath: string, argv: string[]): string[] {
    const home = process.env.HOME ?? "/home/unknown";
    const args = [
      "bwrap",
      "--ro-bind", "/usr", "/usr",
      "--proc", "/proc",
      "--dev", "/dev",
      "--tmpfs", "/tmp",
      "--bind", worktreePath, worktreePath,
      "--ro-bind", `${home}/.claude`, `${home}/.claude`,
      "--ro-bind", `${home}/.codex`, `${home}/.codex`,
      "--setenv", "HOME", home,
    ];
    for (const path of profile.extraReadPaths ?? []) args.push("--ro-bind", path, path);
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
    try {
      execFileSync("bwrap", ["--version"], { stdio: "ignore" });
      OsSandbox.bwrapAvailable = true;
    } catch {
      OsSandbox.bwrapAvailable = false;
    }
    return OsSandbox.bwrapAvailable;
  }
}
