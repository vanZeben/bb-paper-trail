/**
 * memory.ts — in-memory Store with the same semantics as the sqlite store (JSON round-trip, upgrade + schema parse on
 * read, invalid rows skipped, ids ordered ascending, inclusive bounds). For tests of every other module.
 */
import type { ZodType } from "zod";
import type { Log } from "../engine/runner";
import type { ListOptions, RecordRow, Store } from "./port";
import { readRow } from "./store";

interface MemoryRow {
  version: number;
  json: string;
  updatedAt: string;
}

export interface MemoryStoreOptions {
  log?: Log;
  /** Clock for `updatedAt`; defaults to the real time. */
  now?: () => Date;
}

export interface MemoryStore extends Store {
  /** Test hook: plant a raw serialized row (e.g. corrupt JSON or an odd version) that `set` could not produce. */
  putRaw(kind: string, id: string, version: number, json: string): void;
}

export function createMemoryStore(opts: MemoryStoreOptions = {}): MemoryStore {
  const { log } = opts;
  const now = opts.now ?? (() => new Date());
  const kinds = new Map<string, Map<string, MemoryRow>>();
  const meta = new Map<string, string>();

  return {
    putRaw(kind, id, version, json) {
      let table = kinds.get(kind);
      if (table === undefined) {
        table = new Map();
        kinds.set(kind, table);
      }
      table.set(id, { version, json, updatedAt: now().toISOString() });
    },
    async get<T>(kind: string, id: string, schema: ZodType<T>): Promise<T | null> {
      const row = kinds.get(kind)?.get(id);
      if (row === undefined) return null;
      return readRow(kind, id, row.version, row.json, row.updatedAt, schema, log)?.value ?? null;
    },
    async set<T>(kind: string, id: string, value: T, version = 1): Promise<void> {
      const json = JSON.stringify(value);
      if (json === undefined) throw new Error(`storage: cannot store undefined for ${kind}/${id}`);
      let table = kinds.get(kind);
      if (table === undefined) {
        table = new Map();
        kinds.set(kind, table);
      }
      const stored = table.get(id);
      if (stored !== undefined && stored.version > version) throw new Error(`storage: refusing to overwrite ${kind}/${id} (stored by a newer version than ${version})`);
      table.set(id, { version, json, updatedAt: now().toISOString() });
    },
    async list<T>(kind: string, schema: ZodType<T>, o: ListOptions = {}): Promise<Array<RecordRow<T>>> {
      const table = kinds.get(kind);
      if (table === undefined) return [];
      // Plain code-unit ordering, which matches SQLite's BINARY collation on ids.
      const ids = [...table.keys()].filter((id) => (o.from === undefined || id >= o.from) && (o.to === undefined || id <= o.to)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const out: Array<RecordRow<T>> = [];
      for (const id of ids) {
        if (o.limit !== undefined && out.length >= o.limit) break;
        const row = table.get(id)!;
        const parsed = readRow(kind, id, row.version, row.json, row.updatedAt, schema, log);
        if (parsed !== null) out.push(parsed);
      }
      return out;
    },
    async delete(kind: string, id: string): Promise<void> {
      kinds.get(kind)?.delete(id);
    },
    async getMeta(key: string): Promise<string | null> {
      return meta.get(key) ?? null;
    },
    async setMeta(key: string, value: string): Promise<void> {
      meta.set(key, value);
    },
  };
}
