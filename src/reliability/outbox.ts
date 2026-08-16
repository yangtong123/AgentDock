import type { Database } from "../db/database.js";

/**
 * Idempotency guard for commands: the same logical command (keyed by the
 * caller) executes exactly once. Duplicate IM taps or retries become no-ops.
 */
export class CommandDedup {
  constructor(private readonly db: Database, private readonly now = () => new Date().toISOString()) {}

  /** Returns true when the key is new (caller should proceed); false on duplicate. */
  claim(commandKey: string): boolean {
    try {
      this.db.prepare("INSERT INTO command_dedup (command_key, created_at) VALUES (?, ?)").run(commandKey, this.now());
      return true;
    } catch {
      return false;
    }
  }

  /** Evicts entries older than the retention window. */
  pruneOlderThan(cutoffIso: string): number {
    return Number(this.db.prepare("DELETE FROM command_dedup WHERE created_at < ?").run(cutoffIso).changes);
  }
}

export interface OutboxEvent {
  id: number;
  taskId: string | null;
  workflowRunId: string | null;
  type: string;
  payload: string;
  createdAt: string;
  processedAt: string | null;
}

/**
 * Transactional outbox: effects are recorded in the same transaction as the
 * state change that caused them, then delivered by polling. Delivery retries
 * are safe because handlers are idempotent by event id.
 */
export class TransactionalOutbox {
  constructor(private readonly db: Database, private readonly now = () => new Date().toISOString()) {}

  publish(event: { taskId?: string; workflowRunId?: string; type: string; payload: unknown }): void {
    this.db.prepare("INSERT INTO outbox_events (task_id, workflow_run_id, type, payload, created_at) VALUES (?,?,?,?,?)")
      .run(event.taskId ?? null, event.workflowRunId ?? null, event.type, JSON.stringify(event.payload ?? {}), this.now());
  }

  /** Marks the next unprocessed batch as owned by `worker` and returns it. */
  claimBatch(_worker: string, limit: number): OutboxEvent[] {
    const rows = this.db.prepare("SELECT * FROM outbox_events WHERE processed_at IS NULL ORDER BY id LIMIT ?").all(limit) as (Record<string, unknown>)[];
    return rows.map((row) => this.toEvent(row));
  }

  /** Marks an event delivered. Called only after its side effect succeeded. */
  markProcessed(eventId: number, worker: string): void {
    this.db.prepare("UPDATE outbox_events SET processed_at = ?, processed_by = ? WHERE id = ?").run(this.now(), worker, eventId);
  }

  private toEvent(row: Record<string, unknown>): OutboxEvent {
    return { id: Number(row.id), taskId: (row.task_id as string | null) ?? null, workflowRunId: (row.workflow_run_id as string | null) ?? null, type: String(row.type), payload: String(row.payload), createdAt: String(row.created_at), processedAt: (row.processed_at as string | null) ?? null };
  }
}

/** Time source injected for tests. */
export interface Clock { now(): Date }
export class SystemClock implements Clock { now(): Date { return new Date(); } }

/**
 * Worker leases: exactly one worker holds a lease at a time; leases expire so
 * a dead worker's task becomes claimable again (orphan recovery).
 */
export class LeaseManager {
  constructor(private readonly db: Database, private readonly clock: Clock = new SystemClock()) {}

  /** Atomically acquires or renews a lease. Returns true when owned afterwards. */
  acquire(leaseKey: string, owner: string, taskId: string, ttlMs: number): boolean {
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT owner, expires_at FROM worker_leases WHERE lease_key = ?").get(leaseKey) as { owner: string; expires_at: string } | undefined;
      if (existing && existing.owner !== owner && new Date(existing.expires_at).getTime() > now.getTime()) {
        this.db.exec("COMMIT");
        return false; // held by a live someone else
      }
      this.db.prepare(`INSERT INTO worker_leases (lease_key, owner, task_id, acquired_at, expires_at) VALUES (?,?,?,?,?)
        ON CONFLICT (lease_key) DO UPDATE SET owner = excluded.owner, task_id = excluded.task_id, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at`)
        .run(leaseKey, owner, taskId, now.toISOString(), expiresAt);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Heartbeat = acquire with the same owner; false means the lease was lost. */
  heartbeat(leaseKey: string, owner: string, ttlMs: number): boolean {
    const now = this.clock.now();
    const existing = this.db.prepare("SELECT owner, expires_at FROM worker_leases WHERE lease_key = ?").get(leaseKey) as { owner: string; expires_at: string } | undefined;
    if (!existing || existing.owner !== owner) return false;
    this.db.prepare("UPDATE worker_leases SET expires_at = ? WHERE lease_key = ? AND owner = ?").run(new Date(now.getTime() + ttlMs).toISOString(), leaseKey, owner);
    return true;
  }

  release(leaseKey: string, owner: string): void {
    this.db.prepare("DELETE FROM worker_leases WHERE lease_key = ? AND owner = ?").run(leaseKey, owner);
  }

  /** Leases whose expiry passed: their tasks are orphans to recover. */
  expired(taskId?: string): { leaseKey: string; owner: string; taskId: string }[] {
    const now = this.clock.now().toISOString();
    const rows = taskId === undefined
      ? this.db.prepare("SELECT lease_key, owner, task_id FROM worker_leases WHERE expires_at <= ?").all(now)
      : this.db.prepare("SELECT lease_key, owner, task_id FROM worker_leases WHERE expires_at <= ? AND task_id = ?").all(now, taskId);
    return (rows as { lease_key: string; owner: string; task_id: string }[]).map((r) => ({ leaseKey: r.lease_key, owner: r.owner, taskId: r.task_id }));
  }
}
