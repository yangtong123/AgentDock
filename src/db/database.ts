import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Database = DatabaseSync;

function migrationsDirectory(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../migrations");
}

export function migrate(db: Database, directory = migrationsDirectory()): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = db.prepare("SELECT name FROM schema_migrations").all().map((row) => String(row.name));
  for (const name of readdirSync(directory).filter((file) => file.endsWith(".sql")).sort()) {
    if (applied.includes(name)) continue;
    const sql = readFileSync(resolve(directory, name), "utf8");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(name, new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function openDatabase(path: string, options: { migrate?: boolean } = {}): Database {
  if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000");
  if (options.migrate !== false) migrate(db);
  return db;
}

/**
 * Runs fn inside BEGIN IMMEDIATE/COMMIT, rolling back on error. Compound
 * domain operations (e.g. approve + enqueue) must commit through one such
 * transaction: recovery and lease acquisition in other processes classify
 * from durable state and must never observe half of the operation.
 *
 * fn must be synchronous. Awaiting inside fn would yield the event loop
 * while the write transaction is open, and any same-connection re-entry
 * (another BEGIN IMMEDIATE from a queued continuation) throws "cannot start
 * a transaction within a transaction". This is why WorkflowEngine.start /
 * approve / GitHubService.startFixWorkflow have synchronous signatures.
 *
 * Latency pokes recorded inside the transaction (ActivityLog) are deferred
 * until after COMMIT and dropped on ROLLBACK: firing them mid-transaction
 * would let an in-process consumer read uncommitted rows (same connection),
 * send them, and advance its durable cursor past ids the rollback returns
 * to the id pool — the later committed event would reuse an id and be
 * skipped on reconnect.
 */
type Poke = () => void;
const transactionDepths = new WeakMap<Database, number>();
const pendingPokes = new WeakMap<Database, Poke[]>();

/** Fires immediately outside a write transaction; queues it while one is open. */
export function deferOrFirePoke(db: Database, poke: Poke): void {
  if ((transactionDepths.get(db) ?? 0) > 0) {
    let queue = pendingPokes.get(db);
    if (queue === undefined) { queue = []; pendingPokes.set(db, queue); }
    queue.push(poke);
    return;
  }
  poke();
}

export function withImmediateTransaction<T>(db: Database, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  transactionDepths.set(db, (transactionDepths.get(db) ?? 0) + 1);
  let result: T;
  try {
    result = fn();
  } catch (error) {
    db.exec("ROLLBACK");
    transactionDepths.set(db, (transactionDepths.get(db) ?? 1) - 1);
    pendingPokes.get(db)?.splice(0); // rolled back: the pokes never happened
    throw error;
  }
  db.exec("COMMIT");
  transactionDepths.set(db, (transactionDepths.get(db) ?? 1) - 1);
  const queued = pendingPokes.get(db)?.splice(0) ?? [];
  for (const poke of queued) poke();
  return result;
}
