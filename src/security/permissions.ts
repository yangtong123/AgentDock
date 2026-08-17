import type { Database } from "../db/database.js";

/**
 * Layer-2 intent, resolved to a mechanism per platform at plan() time:
 * write-jail → sandbox-exec (Seatbelt) on macOS, bwrap on Linux.
 * "none" disables OS enforcement entirely (full-access only).
 */
export type OsSandboxMode = "none" | "write-jail";

/** Named permission profile controlling what coding agents may do. */
export interface PermissionProfile {
  name: string;
  /** Env var allowlist additions beyond the base agent allowlist. */
  envAllow: string[];
  /** Maximum wall-clock ms per agent step. */
  stepTimeoutMs: number;
  /**
   * Extra directories agents may read beyond defaults (enforced by the OS sandbox).
   * Note: there is deliberately no networkAccess flag — neither Seatbelt nor
   * bwrap can distinguish the agent CLI's own model-API traffic from its
   * children's traffic, so a network deny would break the agent entirely.
   * Network restriction is the provider sandbox's job (codex workspace-write
   * defaults to localhost-only for children; claude denies WebFetch/WebSearch
   * via --disallowedTools).
   */
  extraReadPaths: string[];
  /**
   * Provider-native permission mode (layer 1): the agent CLI polices its own
   * tools. "provider-sandboxed" maps to codex -s workspace-write and
   * claude --permission-mode acceptEdits + a conservative tool allowlist.
   * "full-access" keeps the old dangerous flags for projects that opt in.
   */
  providerMode: "provider-sandboxed" | "full-access";
  /**
   * OS-level enforcement (layer 2). write-jail is fail-closed for the
   * restricted-class profiles: when no mechanism exists on the platform the
   * run is refused rather than silently unsandboxed.
   */
  osSandbox: OsSandboxMode;
  /** When true, an unavailable OS sandbox fails the run instead of degrading. */
  failClosed: boolean;
}

export const PROFILES: Record<string, PermissionProfile> = {
  default: { name: "default", envAllow: [], stepTimeoutMs: 30 * 60 * 1000, extraReadPaths: [], providerMode: "provider-sandboxed", osSandbox: "write-jail", failClosed: true },
  restricted: { name: "restricted", envAllow: [], stepTimeoutMs: 15 * 60 * 1000, extraReadPaths: [], providerMode: "provider-sandboxed", osSandbox: "write-jail", failClosed: true },
  sandboxed: { name: "sandboxed", envAllow: [], stepTimeoutMs: 10 * 60 * 1000, extraReadPaths: [], providerMode: "provider-sandboxed", osSandbox: "write-jail", failClosed: true },
  // Legacy behavior for projects that manage isolation externally.
  "full-access": { name: "full-access", envAllow: [], stepTimeoutMs: 30 * 60 * 1000, extraReadPaths: [], providerMode: "full-access", osSandbox: "none", failClosed: false },
};

export function resolveProfile(name: string | null | undefined): PermissionProfile {
  if (name === null || name === undefined) return PROFILES["default"]!;
  const profile = PROFILES[name];
  if (profile === undefined) throw new Error(`Unknown permission profile: ${name} (expected ${Object.keys(PROFILES).join(", ")})`);
  return profile;
}

/**
 * Secret isolation: strips credential-shaped variables before they reach a
 * coding agent, independent of the profile allowlist. The orchestrator's own
 * tokens (bot tokens, gh auth) must never leak into agent environments.
 */
const SECRET_PATTERNS = [
  /^.*_TOKEN$/i, /^.*_KEY$/i, /^.*_SECRET$/i, /^.*_PASSWORD$/i, /^.*_CREDENTIALS?$/i,
  /^GITHUB_TOKEN$/i, /^GH_TOKEN$/i, /^ANTHROPIC_API_KEY$/i, /^OPENAI_API_KEY$/i, /^TELEGRAM_BOT_TOKEN$/i,
];

export class SecretIsolation {
  /** Removes credential-shaped entries from an env record. Returns the sanitized copy. */
  static sanitize(env: Record<string, string>): Record<string, string> {
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (SECRET_PATTERNS.some((pattern) => pattern.test(key))) continue;
      clean[key] = value;
    }
    return clean;
  }

  /** Reports which keys would be stripped (for audit logs). */
  static flaggedKeys(env: Record<string, string>): string[] {
    return Object.keys(env).filter((key) => SECRET_PATTERNS.some((pattern) => pattern.test(key)));
  }
}

/**
 * Audit log: append-only record of who did what to which task. IM taps,
 * approvals, cancellations, PR creation — everything durable state depends on.
 */
export class AuditLog {
  constructor(private readonly db: Database, private readonly now = () => new Date().toISOString()) {}

  record(entry: { actor: string; action: string; taskId?: string; detail?: Record<string, unknown> }): void {
    this.db.prepare("INSERT INTO audit_log (actor, action, task_id, detail, created_at) VALUES (?,?,?,?,?)")
      .run(entry.actor, entry.action, entry.taskId ?? null, JSON.stringify(entry.detail ?? {}), this.now());
  }

  list(filter: { taskId?: string; actor?: string; limit?: number } = {}): { id: number; actor: string; action: string; taskId: string | null; detail: string; createdAt: string }[] {
    const limit = filter.limit ?? 100;
    const rows = filter.taskId !== undefined && filter.actor !== undefined
      ? this.db.prepare("SELECT * FROM audit_log WHERE task_id = ? AND actor = ? ORDER BY id DESC LIMIT ?").all(filter.taskId, filter.actor, limit)
      : filter.taskId !== undefined
        ? this.db.prepare("SELECT * FROM audit_log WHERE task_id = ? ORDER BY id DESC LIMIT ?").all(filter.taskId, limit)
        : filter.actor !== undefined
          ? this.db.prepare("SELECT * FROM audit_log WHERE actor = ? ORDER BY id DESC LIMIT ?").all(filter.actor, limit)
          : this.db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(limit);
    return (rows as Record<string, unknown>[]).map((row) => ({ id: Number(row.id), actor: String(row.actor), action: String(row.action), taskId: (row.task_id as string | null) ?? null, detail: String(row.detail), createdAt: String(row.created_at) }));
  }
}
