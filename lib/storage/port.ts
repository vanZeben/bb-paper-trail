/**
 * port.ts — the persistence port every engine and feature module uses. storage/store.ts implements it on the
 * plugin's own SQLite database (`records(kind, id, version, json, updated_at)` + `meta(key, value)`); tests use
 * createMemoryStore() from storage/memory.ts. Reads always go through a zod schema.
 */
import type { ZodType } from "zod";

export interface RecordRow<T> {
  id: string;
  value: T;
  updatedAt: string;
}

export interface ListOptions {
  /** Inclusive id bounds (ids are dates, ISO weeks or other sortable keys). */
  from?: string;
  to?: string;
  limit?: number;
}

export interface Store {
  get<T>(kind: string, id: string, schema: ZodType<T>): Promise<T | null>;
  /** `version` defaults to 1; bump it per kind when a breaking schema change needs an upgrade step. */
  set<T>(kind: string, id: string, value: T, version?: number): Promise<void>;
  /** Rows of one kind ordered by id ascending. Rows that fail the schema are skipped (and logged by the implementation). */
  list<T>(kind: string, schema: ZodType<T>, opts?: ListOptions): Promise<Array<RecordRow<T>>>;
  delete(kind: string, id: string): Promise<void>;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
}

/** Record kinds (plan section 4.3). Feature modules use these constants, never string literals. */
export const KIND = {
  day: "day",
  week: "week",
  index: "index",
  framework: "framework",
  connectors: "connectors",
  targets: "targets",
  drift: "drift",
  rules: "rules",
  violation: "violation",
  override: "override",
  plan: "plan",
  threads: "threads",
  threadEdit: "thread-edit",
  closure: "closure",
  ghost: "ghost",
  addenda: "addenda",
  mix: "mix",
  packet: "packet",
  profile: "profile",
  setup: "setup",
  goals: "goals",
} as const;
export type Kind = (typeof KIND)[keyof typeof KIND];
