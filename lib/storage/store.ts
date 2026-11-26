/**
 * store.ts — SQLite implementation of the Store port (storage/port.ts) over the `records` / `meta` tables.
 * Every read parses the stored JSON through the caller's zod schema, after `upgrade()` has lifted old row versions to
 * the current shape. A row that cannot be parsed or upgraded is skipped and logged, never thrown, so one bad row
 * cannot take a whole view down.
 */
import type Database from "better-sqlite3";
import type { ZodType } from "zod";
import type { Log } from "../engine/runner";
import type { ListOptions, RecordRow, Store } from "./port";

/**
 * Lifts a stored row to the shape the current schema expects. Identity today. When a kind needs a breaking change,
 * bump the version passed to `set` for that kind and add one `case` here (switch on `kind` inside the version case,
 * or fall through version steps). Additive changes need no case: schema defaults handle them.
 */
export function upgrade(kind: string, version: number, json: unknown): unknown {
  switch (version) {
    case 1:
      return json;
    default:
      // Rows written by a newer build, or version 0 / garbage: let the schema decide. Reject only impossible versions.
      if (!Number.isInteger(version) || version < 1) throw new Error(`unsupported version ${version} for kind ${kind}`);
      return json;
  }
}

/** Shared by the sqlite and memory stores so both behave identically on a bad row. */
export function readRow<T>(
  kind: string,
  id: string,
  version: number,
  rawJson: string,
  updatedAt: string,
  schema: ZodType<T>,
  log?: Log,
): RecordRow<T> | null {
  try {
    const parsed = schema.safeParse(upgrade(kind, version, JSON.parse(rawJson)));
    if (parsed.success) return { id, value: parsed.data, updatedAt };
    log?.warn(`storage: skipped invalid ${kind}/${id} (v${version}): ${parsed.error.issues[0]?.message ?? "schema mismatch"}`);
  } catch (cause) {
    log?.warn(`storage: skipped unreadable ${kind}/${id}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return null;
}

interface Row {
  id: string;
  version: number;
  json: string;
  updated_at: string;
}

export function createSqliteStore(db: Database.Database, log?: Log): Store {
  const getStmt = db.prepare("SELECT id, version, json, updated_at FROM records WHERE kind = ? AND id = ?");
  const setStmt = db.prepare(
    `INSERT INTO records (kind, id, version, json, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (kind, id) DO UPDATE SET version = excluded.version, json = excluded.json, updated_at = excluded.updated_at
     WHERE excluded.version >= records.version`,
  );
  const deleteStmt = db.prepare("DELETE FROM records WHERE kind = ? AND id = ?");
  const getMetaStmt = db.prepare("SELECT value FROM meta WHERE key = ?");
  const setMetaStmt = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");

  return {
    async get<T>(kind: string, id: string, schema: ZodType<T>): Promise<T | null> {
      const row = getStmt.get(kind, id) as Row | undefined;
      if (row === undefined) return null;
      return readRow(kind, row.id, row.version, row.json, row.updated_at, schema, log)?.value ?? null;
    },
    async set<T>(kind: string, id: string, value: T, version = 1): Promise<void> {
      const json = JSON.stringify(value);
      if (json === undefined) throw new Error(`storage: cannot store undefined for ${kind}/${id}`);
      const res = setStmt.run(kind, id, version, json, new Date().toISOString());
      // The conditional upsert skipped the row: it was written by a newer build and must not be downgraded.
      if (res.changes === 0) throw new Error(`storage: refusing to overwrite ${kind}/${id} (stored by a newer version than ${version})`);
    },
    async list<T>(kind: string, schema: ZodType<T>, opts: ListOptions = {}): Promise<Array<RecordRow<T>>> {
      const where = ["kind = ?"];
      const params: Array<string | number> = [kind];
      if (opts.from !== undefined) {
        where.push("id >= ?");
        params.push(opts.from);
      }
      if (opts.to !== undefined) {
        where.push("id <= ?");
        params.push(opts.to);
      }
      // A limit applies to valid rows, so it is enforced here after skipping rather than in SQL.
      const rows = db.prepare(`SELECT id, version, json, updated_at FROM records WHERE ${where.join(" AND ")} ORDER BY id ASC`).all(...params) as Row[];
      const out: Array<RecordRow<T>> = [];
      for (const row of rows) {
        if (opts.limit !== undefined && out.length >= opts.limit) break;
        const parsed = readRow(kind, row.id, row.version, row.json, row.updated_at, schema, log);
        if (parsed !== null) out.push(parsed);
      }
      return out;
    },
    async delete(kind: string, id: string): Promise<void> {
      deleteStmt.run(kind, id);
    },
    async getMeta(key: string): Promise<string | null> {
      const row = getMetaStmt.get(key) as { value: string } | undefined;
      return row?.value ?? null;
    },
    async setMeta(key: string, value: string): Promise<void> {
      setMetaStmt.run(key, value);
    },
  };
}
