import type { Database } from "../db/database.js";

/** Named permission profile controlling what coding agents may do. */
export interface PermissionProfile {
  name: string;
  /** Env var allowlist additions beyond the base agent allowlist. */
  envAllow: string[];
  /** Maximum wall-clock ms per agent step. */
  stepTimeoutMs: number;
  /** Whether agents may access the network at all (informational for CLI agents, enforced in env: no proxy vars). */
  networkAccess: boolean;
  /** Extra directories agents may read (informational). */
  extraReadPaths: string[];
}

export const PROFILES: Record<string, PermissionProfile> = {
  default: { name: "default", envAllow: [], stepTimeoutMs: 30 * 60 * 1000, networkAccess: true, extraReadPaths: [] },
  restricted: { name: "restricted", envAllow: [], stepTimeoutMs: 15 * 60 * 1000, networkAccess: false, extraReadPaths: [] },
  sandboxed: { name: "sandboxed", envAllow: [], stepTimeoutMs: 10 * 60 * 1000, networkAccess: false, extraReadPaths: [] },
};

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
  constructor(private readonly db: Database, private readonly now = () => new Date().toISOString()) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      task_id TEXT,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
  }

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
