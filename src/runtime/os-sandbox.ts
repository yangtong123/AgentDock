import type { OsSandboxMode, PermissionProfile } from "../security/permissions.js";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

export interface SandboxPlan {
  /** Effective mode after capability detection (e.g. bwrap requested but missing → none + warning). */
  mode: OsSandboxMode;
  /** Wrapped argv; identical to input when mode is none. */
  argv: string[];
  /** Set when the requested mode was unavailable and enforcement was skipped. */
  fallbackReason: string | null;
}

/**
 * Layer-2 OS sandbox: wraps agent argv with sandbox-exec (macOS Seatbelt) or
 * bwrap (Linux) so a compromised agent cannot write outside its worktree or,
 * when the profile forbids it, reach the network — regardless of what the
 * agent CLI itself allows. The profile is the policy; this is the
 * enforcement that does not trust the agent.
 */
export class OsSandbox {
  private static bwrapAvailable: boolean | null = null;

  /** Resolves the plan for one agent invocation. Pure: no I/O beyond capability flags. */
  static plan(profile: PermissionProfile, worktreePath: string, argv: string[], options: { bwrapAvailable?: boolean } = {}): SandboxPlan {
    const requested = profile.osSandbox;
    if (requested === "none") return { mode: "none", argv, fallbackReason: null };
    if (requested === "macos-seatbelt") {
      if (process.platform !== "darwin") {
        return { mode: "none", argv, fallbackReason: "macos-seatbelt requested on non-darwin platform" };
      }
      return { mode: requested, argv: ["sandbox-exec", "-p", this.seatbeltProfile(profile, worktreePath), "--", ...argv], fallbackReason: null };
    }
    // linux-bwrap
    const available = options.bwrapAvailable ?? this.detectBwrap();
    if (!available) {
      return { mode: "none", argv, fallbackReason: "linux-bwrap requested but bwrap is not installed" };
    }
    return { mode: requested, argv: this.bwrapArgv(profile, worktreePath, argv), fallbackReason: null };
  }

  /**
   * Seatbelt profile: writes confined to the worktree, agent config/cache dirs
   * (~/.claude, ~/.codex), and tmp. Everything else is read-only. Network is
   * NOT denied here: the agent CLI's own model-API traffic would break, and
   * Seatbelt cannot distinguish it from child-process traffic. Agent-child
   * network restriction is the provider sandbox's job (codex workspace-write
   * defaults to localhost-only; claude denies WebFetch/WebSearch via
   * --disallowedTools). Paths are realpath-normalized because Seatbelt matches
   * literal prefixes — /tmp vs /private/tmp mismatches would silently deny
   * legitimate writes.
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

  /** realpath with a fallback for paths that do not exist yet (worktrees are created before first run). */
  private static normalize(path: string): string {
    try { return realpathSync(path); } catch { return path; }
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
