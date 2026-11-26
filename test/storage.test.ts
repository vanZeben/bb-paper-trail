import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { z } from "zod";
import { MIGRATIONS, openDatabase } from "../lib/storage/db";
import { createMemoryStore } from "../lib/storage/memory";
import { createSqliteStore, upgrade } from "../lib/storage/store";
import type { Store } from "../lib/storage/port";

const schema = z.object({ n: z.number(), label: z.string().default("x") });

function loadSqlite(): (new (path: string) => import("better-sqlite3").Database) | null {
  try {
    const Ctor = createRequire(import.meta.url)("better-sqlite3");
    new Ctor(":memory:").close();
    return Ctor;
  } catch {
    return null;
  }
}
const Sqlite = loadSqlite();

function suite(name: string, make: () => { store: Store; warnings: string[]; plantRaw: (kind: string, id: string, version: number, json: string) => void }) {
  describe(name, () => {
    it("round-trips and overwrites", async () => {
      const { store } = make();
      expect(await store.get("day", "2026-01-05", schema)).toBeNull();
      await store.set("day", "2026-01-05", { n: 1 });
      expect(await store.get("day", "2026-01-05", schema)).toEqual({ n: 1, label: "x" });
      await store.set("day", "2026-01-05", { n: 2, label: "y" });
      expect(await store.get("day", "2026-01-05", schema)).toEqual({ n: 2, label: "y" });
    });

    it("keeps kinds apart and deletes", async () => {
      const { store } = make();
      await store.set("day", "a", { n: 1 });
      await store.set("week", "a", { n: 2 });
      await store.delete("day", "a");
      expect(await store.get("day", "a", schema)).toBeNull();
      expect((await store.get("week", "a", schema))?.n).toBe(2);
      await store.delete("day", "missing");
    });

    it("lists by id with inclusive from/to and limit", async () => {
      const { store } = make();
      for (const id of ["2026-01-07", "2026-01-05", "2026-01-06", "2026-01-08"]) await store.set("day", id, { n: Number(id.slice(-2)) });
      await store.set("week", "2026-W02", { n: 99 });
      expect((await store.list("day", schema)).map((r) => r.id)).toEqual(["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08"]);
      expect((await store.list("day", schema, { from: "2026-01-06", to: "2026-01-07" })).map((r) => r.id)).toEqual(["2026-01-06", "2026-01-07"]);
      expect((await store.list("day", schema, { from: "2026-01-07" })).map((r) => r.id)).toEqual(["2026-01-07", "2026-01-08"]);
      expect((await store.list("day", schema, { to: "2026-01-05" })).map((r) => r.id)).toEqual(["2026-01-05"]);
      expect((await store.list("day", schema, { limit: 2 })).map((r) => r.id)).toEqual(["2026-01-05", "2026-01-06"]);
      expect(await store.list("none", schema)).toEqual([]);
      const first = (await store.list("day", schema, { limit: 1 }))[0]!;
      expect(first.value.n).toBe(5);
      expect(Number.isNaN(Date.parse(first.updatedAt))).toBe(false);
    });

    it("skips and logs invalid rows (schema mismatch and corrupt json) without throwing", async () => {
      const { store, warnings, plantRaw } = make();
      await store.set("day", "2026-01-05", { n: 1 });
      await store.set("day", "2026-01-06", { n: "not a number" });
      plantRaw("day", "2026-01-07", 1, "{not json");
      plantRaw("day", "2026-01-08", 0, JSON.stringify({ n: 8 }));
      await store.set("day", "2026-01-09", { n: 9 });
      expect(await store.get("day", "2026-01-06", schema)).toBeNull();
      expect(await store.get("day", "2026-01-07", schema)).toBeNull();
      expect((await store.list("day", schema)).map((r) => r.id)).toEqual(["2026-01-05", "2026-01-09"]);
      expect(warnings.length).toBeGreaterThanOrEqual(3);
      expect(warnings.some((w) => w.includes("day/2026-01-06"))).toBe(true);
    });

    it("limit counts valid rows only", async () => {
      const { store } = make();
      await store.set("day", "a", { n: "bad" });
      await store.set("day", "b", { n: 1 });
      await store.set("day", "c", { n: 2 });
      expect((await store.list("day", schema, { limit: 2 })).map((r) => r.id)).toEqual(["b", "c"]);
    });

    it("stores meta scalars", async () => {
      const { store } = make();
      expect(await store.getMeta("daily_last_slot")).toBeNull();
      await store.setMeta("daily_last_slot", "2026-01-05T17:45");
      await store.setMeta("daily_last_slot", "2026-01-06T17:45");
      expect(await store.getMeta("daily_last_slot")).toBe("2026-01-06T17:45");
    });

    it("rejects undefined values", async () => {
      const { store } = make();
      await expect(store.set("day", "a", undefined)).rejects.toThrow(/undefined/);
      expect(await store.get("day", "a", schema)).toBeNull();
    });

    it("never overwrites a row stored at a higher version", async () => {
      const { store } = make();
      await store.set("day", "v", { n: 1, label: "new" }, 2);
      await expect(store.set("day", "v", { n: 9, label: "old" }, 1)).rejects.toThrow(/refusing to overwrite/);
      expect(await store.get("day", "v", schema)).toEqual({ n: 1, label: "new" });
      await store.set("day", "v", { n: 2, label: "same" }, 2);
      await store.set("day", "v", { n: 3, label: "up" }, 3);
      expect(await store.get("day", "v", schema)).toEqual({ n: 3, label: "up" });
    });
  });
}

function logger() {
  const warnings: string[] = [];
  return { warnings, log: { info: () => undefined, warn: (m: string) => void warnings.push(m) } };
}

suite("memory store", () => {
  const { warnings, log } = logger();
  const store = createMemoryStore({ log });
  return { store, warnings, plantRaw: store.putRaw };
});

describe("upgrade", () => {
  it("is identity for v1 and later, rejects impossible versions", () => {
    expect(upgrade("day", 1, { a: 1 })).toEqual({ a: 1 });
    expect(upgrade("day", 2, { a: 1 })).toEqual({ a: 1 });
    expect(() => upgrade("day", 0, {})).toThrow();
  });
});

describe.skipIf(Sqlite === null)("sqlite store", () => {
  it("migrates idempotently and exposes the schema", () => {
    const db = new Sqlite!(":memory:");
    const bb = fakeBb(db);
    openDatabase(bb);
    openDatabase(bb);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('records','meta') ORDER BY name").all();
    expect(tables).toEqual([{ name: "meta" }, { name: "records" }]);
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(2);
  });

  suite("sqlite", () => {
    const db = new Sqlite!(":memory:");
    const { warnings, log } = logger();
    const store = createSqliteStore(openDatabase(fakeBb(db)), log);
    const plantRaw = (kind: string, id: string, version: number, json: string) => {
      db.prepare("INSERT INTO records (kind, id, version, json, updated_at) VALUES (?, ?, ?, ?, ?)").run(kind, id, version, json, new Date().toISOString());
    };
    return { store, warnings, plantRaw };
  });
});

function fakeBb(db: import("better-sqlite3").Database) {
  const applied = new Set<number>();
  return {
    storage: {
      database: () => db,
      migrate: (d: import("better-sqlite3").Database, statements: string[]) => {
        statements.forEach((sql, i) => {
          if (applied.has(i)) return;
          d.exec(sql);
          applied.add(i);
        });
      },
    },
  };
}
