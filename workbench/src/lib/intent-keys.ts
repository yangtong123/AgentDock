/**
 * Idempotency-key lifecycle for one user intent. The key survives failures —
 * a retry after an ambiguous failure (network drop after a server commit) must
 * hit the server's replay path, not duplicate the mutation. The key rotates
 * only on success or explicit reset. begin() returns null while in flight
 * (double-click guard).
 */
export class IntentKeys {
  private currentKey: string | null = null;
  private pending = false;

  /** Starts an attempt; returns the intent key, or null when one is in flight. */
  begin(): string | null {
    if (this.pending) return null;
    this.pending = true;
    if (this.currentKey === null) this.currentKey = crypto.randomUUID();
    return this.currentKey;
  }

  /** Failure: the intent survives — the next begin() reuses the key. */
  fail(): void {
    this.pending = false;
  }

  /** Success: the intent is consumed; the next begin() mints a fresh key. */
  settle(): void {
    this.pending = false;
    this.currentKey = null;
  }

  /** Explicit abandon (dialog closed, user cancelled). */
  reset(): void {
    this.pending = false;
    this.currentKey = null;
  }
}
