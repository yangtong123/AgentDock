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
