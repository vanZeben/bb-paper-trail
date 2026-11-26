/**
 * db.ts — opens the plugin's own SQLite database and applies the append-only migrations.
 * `bb.storage.database()` returns the host's better-sqlite3 handle (WAL, busy_timeout 5000); `bb.storage.migrate`
 * runs unapplied statements in one transaction and records a hash per statement. NEVER edit or reorder a shipped
 * statement: append a new one.
 */
import type Database from "better-sqlite3";

/** The slice of `bb.storage` this module uses (the real `PluginStorage` satisfies it). */
export interface StorageHost {
  storage: {
    database(): Database.Database;
    migrate(db: Database.Database, statements: string[]): void;
  };
}

/** Append-only. Index = migration id. */
export const MIGRATIONS: string[] = [
  // 0: records + meta (plan section 4.3)
  `CREATE TABLE records (
     kind TEXT NOT NULL,
     id TEXT NOT NULL,
     version INTEGER NOT NULL,
     json TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (kind, id)
   )`,
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

export function openDatabase(bb: StorageHost): Database.Database {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  return db;
}
