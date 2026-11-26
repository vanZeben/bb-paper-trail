import { describe, expect, it } from "vitest";
import { createRegistry, type FeatureCtx } from "../lib/engine/extensions";
import type { Runner } from "../lib/engine/runner";
import { createWorklogService } from "../lib/engine/service";
import { exportBundle } from "../lib/features/migrate/export";
import { importBundle, lastImport } from "../lib/features/migrate/import";
import { normalizeKind } from "../lib/capture/sources";
import {
  dayStamp, mapDayV1, mapWeekV1, MAX_BUNDLE_CHARS, MAX_BUNDLE_DAYS, MAX_BUNDLE_RECORDS, MAX_BUNDLE_WEEKS, MAX_MEETINGS, normalizeDay, parseBundle, V1_FIELDS, weekStamp,
} from "../lib/features/migrate/bundle";
import { handlers } from "../lib/handlers/migrate";
import { DEFAULT_FRAMEWORK } from "../lib/framework/default";
import { DEFAULT_SETTINGS } from "../lib/settings";
import { createMemoryStore } from "../lib/storage/memory";
import { KIND } from "../lib/storage/port";
import { MAX_EVIDENCE_PER_SOURCE, MAX_REASON, MAX_WHAT, overrideSchema, roleFrameworkSchema, weekAddendaSchema, workDaySchema, workWeekSchema, type RoleFramework } from "../lib/types";

// The original plugin's field names (the manager-list key was named after the manager: any raiseWith<Name> is accepted).
const NOTED_V1 = "granola";
const RAISE_V1 = "raiseWithAlex";
const OLD_CHANNEL_KIND = "legacy_channel";

const ok = { status: "ok", note: null } as const;
const FW: RoleFramework = { ...DEFAULT_FRAMEWORK, id: "acme_eng", name: "Acme engineering", updatedAt: "2026-11-01T00:00:00.000Z" };

const ALL_NINE = ["calendar", "granola", "fellow", "jira", "confluence", "github", "slack", "vault", "memory"];

/** A v1 day as the original plugin stored it (only some of the nine coverage keys: early records predate the later ones). */
function v1Day(date: string, over: Record<string, unknown> = {}) {
  return {
    version: 1,
    date,
    week: "2026-W46",
    capturedAt: "2026-11-12T23:00:00Z",
    coverage: { calendar: ok, granola: ok, jira: ok, github: ok, slack: { status: "partial", note: "rate limited" } },
    meetings: [
      { id: "m1", title: "Design sync", start: `${date}T15:00:00Z`, end: `${date}T16:00:00Z`, minutes: 60, response: "accepted", attendees: 4, [NOTED_V1]: true, passive: null },
    ],
    meetingCount: 1,
    meetingMinutes: 60,
    evidence: [
      { id: "H1112-1", date, source: "github", kind: "pr_merged", what: "Merged the parser fix", link: "https://example.test/pr/1", outcome: "shipped" },
      { id: "S1112-1", date, source: "slack", kind: OLD_CHANNEL_KIND, what: "Posted in the watched channel", link: null, outcome: null },
    ],
    rating: { rating: "meets", provisional: false, reason: "Solid day", summary: "Fixed the parser.", areas: ["delivery"], evidenceIds: ["H1112-1"], ratedAt: "2026-11-13T01:00:00Z", model: "opus" },
    notePath: "somewhere/Daily/2026-11-12.md",
    ...over,
  };
}

function v1Week(week: string, over: Record<string, unknown> = {}) {
  return {
    version: 1,
    week,
    from: "2026-11-09",
    to: "2026-11-15",
    generatedAt: "2026-11-14T22:00:00Z",
    model: "opus",
    final: true,
    rating: "meets",
    ratingReason: "Steady week",
    threeLines: ["a", "b", "c"],
    days: [{ date: "2026-11-12", rating: "meets", reason: "Solid day", summary: "s", evidenceIds: ["H1112-1"] }],
    daysWorked: 1,
    scorecard: [{ area: "delivery", status: "hit", note: "n", evidenceIds: ["H1112-1"] }],
    shipped: [{ text: "Parser fix", evidenceIds: ["H1112-1"] }],
    inProgress: [],
    decisions: [],
    helping: [],
    meetings: { count: 1, hours: 1, pctOfWeek: 3, passiveCount: 0, topSinks: [{ title: "Design sync", hours: 1 }] },
    recognition: [],
    openAsks: [],
    friction: [],
    [RAISE_V1]: [{ text: "Ask about scope", evidenceIds: [] }],
    reflection: { goodWeek: true, text: "Good." },
    coverage: { calendar: ok, granola: ok, jira: ok, github: ok, slack: ok },
    evidence: [{ id: "H1112-1", date: "2026-11-12", source: "github", kind: "pr_merged", what: "Merged the parser fix", link: "https://example.test/pr/1", outcome: "shipped" }],
    notePath: "somewhere/Weekly/2026-W46.md",
    ...over,
  };
}

const bundleOf = (over: Record<string, unknown> = {}) => ({
  format: "paper-trail-bundle",
  version: 1,
  exportedAt: "2026-11-20T00:00:00Z",
  framework: FW,
  days: [v1Day("2026-11-11", { week: "2026-W46" }), v1Day("2026-11-12")],
  weeks: [v1Week("2026-W46"), v1Week("2026-W45", { from: "2026-11-02", to: "2026-11-08", generatedAt: "2026-11-07T22:00:00Z" })],
  ...over,
});

function harness(opts: { stored?: RoleFramework } = {}) {
  const store = createMemoryStore();
  const clock = { now: new Date("2026-11-20T12:00:00Z") };
  const replayed: string[] = [];
  const registry = createRegistry();
  registry.weekHooks.push({ id: "spy", afterWeekSaved: async (w) => void replayed.push(w.week) });
  const runner = { status: () => ({ running: 0, queued: 0 }), runJob: async () => Promise.reject(new Error("no jobs in import tests")) } as unknown as Runner;
  const log = { info: () => undefined, warn: () => undefined };
  const settings = { ...DEFAULT_SETTINGS, timeZone: "America/New_York" };
  let published = 0;
  const framework = async () => (await store.get(KIND.framework, "active", roleFrameworkSchema)) ?? DEFAULT_FRAMEWORK;
  const ctx: FeatureCtx = { store, settings: () => settings, framework, runner, log, publish: () => void (published += 1), now: () => clock.now };
  const service = createWorklogService({
    store, runner, registry, ctx, settings: () => settings, framework, connectors: async () => null, onboarded: async () => true, notify: () => undefined, now: () => clock.now, log,
  });
  const ready = opts.stored ? store.set(KIND.framework, "active", opts.stored) : Promise.resolve();
  return { store, service, ctx, replayed, published: () => published, ready };
}

describe("v1 -> v2 mapping", () => {
  it("maps a day: version, renamed fields, kind alias, area null, ids and ratings unchanged", () => {
    const day = mapDayV1(v1Day("2026-11-12"));
    expect(day.version).toBe(2);
    expect(day.meetings[0]).toMatchObject({ id: "m1", noted: true, passive: null });
    expect(Object.keys(day.meetings[0]!)).not.toContain(NOTED_V1);
    expect(day.evidence.map((e) => [e.id, e.kind, e.area])).toEqual([["H1112-1", "pr_merged", null], ["S1112-1", "watched_channel", null]]);
    expect(Object.keys(day.coverage)).toEqual(ALL_NINE);
    expect(day.coverage.slack).toEqual({ status: "partial", note: "rate limited" });
    expect(day.coverage.vault).toEqual({ status: "failed", note: "not captured" });
    expect(day.rating).toEqual({ rating: "meets", provisional: false, reason: "Solid day", summary: "Fixed the parser.", areas: ["delivery"], evidenceIds: ["H1112-1"], ratedAt: "2026-11-13T01:00:00Z", model: "opus" });
    expect(day.capturedAt).toBe("2026-11-12T23:00:00Z");
    expect(JSON.stringify(day)).not.toContain("notePath");
    expect(workDaySchema.safeParse(day).success).toBe(true);
  });

  it("maps a week: raiseWithManager, notePath dropped, framework snapshot, empty plan and ext", () => {
    const week = mapWeekV1(v1Week("2026-W46"), FW);
    expect(week.version).toBe(2);
    expect(week.raiseWithManager).toEqual([{ text: "Ask about scope", evidenceIds: [] }]);
    expect(Object.keys(week)).not.toContain(RAISE_V1);
    expect(JSON.stringify(week)).not.toContain("notePath");
    expect(week.frameworkId).toBe("acme_eng");
    expect(week.areasSnapshot).toEqual(FW.areas.map((a) => ({ key: a.key, label: a.label })));
    expect(week.plan).toEqual([]);
    expect(week.ext).toEqual({});
    expect(Object.keys(week.coverage)).toEqual(ALL_NINE);
    expect(week).toMatchObject({ generatedAt: "2026-11-14T22:00:00Z", model: "opus", final: true, rating: "meets" });
    expect(week.evidence[0]).toMatchObject({ id: "H1112-1", area: null });
    expect(workWeekSchema.safeParse(week).success).toBe(true);
  });

  it("dayStamp and weekStamp treat a missing or unparseable stamp as 0, never NaN", () => {
    const day = mapDayV1(v1Day("2026-11-12"));
    const noStamp = { ...day, capturedAt: undefined as unknown as string, rating: null };
    expect(dayStamp(noStamp)).toBe(0);
    expect(dayStamp({ ...day, capturedAt: "not a date", rating: null })).toBe(0);
    expect(dayStamp({ ...day, capturedAt: "garbage", rating: { ...day.rating!, ratedAt: "2026-11-13T01:00:00Z" } })).toBe(Date.parse("2026-11-13T01:00:00Z"));
    expect(Number.isNaN(dayStamp({ ...day, rating: { ...day.rating!, ratedAt: undefined as unknown as string } }))).toBe(false);
    expect(weekStamp({ ...mapWeekV1(v1Week("2026-W46"), FW), generatedAt: undefined as unknown as string })).toBe(0);
    // skip-if-newer: a stored day with no stamp never blocks an import that has one.
    expect(dayStamp(noStamp) >= dayStamp(day)).toBe(false);
  });

  it("still accepts the legacy receipts-bundle format", () => {
    expect(parseBundle(bundleOf({ format: "receipts-bundle" })).format).toBe("receipts-bundle");
  });

  it("rejects a document that is not a bundle", () => {
    expect(() => parseBundle({ format: "something-else" })).toThrow(/paper-trail-bundle/);
    expect(() => parseBundle(null)).toThrow();
  });
});

describe("importBundle", () => {
  it("stores days and weeks, rebuilds the index, replays the week hooks and remembers the summary", async () => {
    const h = harness();
    await h.ready;
    const summary = await importBundle(bundleOf(), h);
    expect(summary).toMatchObject({ imported: { days: 2, weeks: 2, records: 1 }, skipped: 0, errors: [] });
    expect((await h.service.day("2026-11-12"))?.version).toBe(2);
    const index = await h.service.index();
    expect(Object.keys(index.days).sort()).toEqual(["2026-11-11", "2026-11-12"]);
    expect(index.weeks["2026-W46"]).toMatchObject({ rating: "meets", final: true });
    expect(h.replayed).toEqual(["2026-W45", "2026-W46"]);
    expect(h.published()).toBeGreaterThan(0);
    expect(await lastImport(h.ctx)).toMatchObject({ imported: { days: 2, weeks: 2, records: 1 }, skipped: 0, at: "2026-11-20T12:00:00.000Z" });
  });

  it("keeps evidence ids, ratings and timestamps unchanged in the stored records", async () => {
    const h = harness();
    await importBundle(bundleOf(), h);
    const day = (await h.service.day("2026-11-12"))!;
    expect(day.evidence.map((e) => e.id)).toEqual(["H1112-1", "S1112-1"]);
    expect(day.rating).toMatchObject({ rating: "meets", provisional: false, ratedAt: "2026-11-13T01:00:00Z", model: "opus" });
    const week = (await h.service.week("2026-W46"))!;
    expect(week.evidence.map((e) => e.id)).toEqual(["H1112-1"]);
    expect(week.generatedAt).toBe("2026-11-14T22:00:00Z");
    expect(week.frameworkId).toBe("acme_eng");
  });

  it("is idempotent: a second import skips everything and changes nothing", async () => {
    const h = harness();
    await importBundle(bundleOf(), h);
    const before = JSON.stringify([await h.store.list(KIND.day, workDaySchema), await h.store.list(KIND.week, workWeekSchema)]);
    const again = await importBundle(bundleOf(), h);
    expect(again).toMatchObject({ imported: { days: 0, weeks: 0, records: 0 }, errors: [] });
    expect(again.skipped).toBe(4);
    expect(JSON.stringify([await h.store.list(KIND.day, workDaySchema), await h.store.list(KIND.week, workWeekSchema)])).toBe(before);
  });

  it("skips a day or week stored with a newer stamp and replaces an older one", async () => {
    const h = harness();
    await importBundle(bundleOf({ days: [v1Day("2026-11-12")], weeks: [v1Week("2026-W46")] }), h);
    // Newer on the server: a later capture, a later judgment.
    const day = (await h.service.day("2026-11-12"))!;
    await h.service.importDay({ ...day, capturedAt: "2026-11-15T00:00:00Z", rating: { ...day.rating!, ratedAt: "2026-11-15T00:00:00Z", reason: "Re-rated" } });
    const week = (await h.service.week("2026-W46"))!;
    await h.service.importWeek({ ...week, generatedAt: "2026-11-16T00:00:00Z", ratingReason: "Rejudged" });
    const skipped = await importBundle(bundleOf({ days: [v1Day("2026-11-12")], weeks: [v1Week("2026-W46")] }), h);
    expect(skipped).toMatchObject({ imported: { days: 0, weeks: 0 }, skipped: 2 });
    expect((await h.service.day("2026-11-12"))?.rating?.reason).toBe("Re-rated");
    expect((await h.service.week("2026-W46"))?.ratingReason).toBe("Rejudged");
    // An older stored record gives way to a newer bundle record.
    const newer = await importBundle(
      bundleOf({ days: [v1Day("2026-11-12", { capturedAt: "2026-11-20T00:00:00Z", rating: null })], weeks: [v1Week("2026-W46", { generatedAt: "2026-11-21T00:00:00Z", ratingReason: "Latest" })] }),
      h,
    );
    expect(newer.imported).toMatchObject({ days: 1, weeks: 1 });
    expect((await h.service.week("2026-W46"))?.ratingReason).toBe("Latest");
  });

  it("applies the bundle's framework only when none is stored or the flag is set", async () => {
    const mine: RoleFramework = { ...DEFAULT_FRAMEWORK, id: "mine", name: "Mine" };
    const withStored = harness({ stored: mine });
    await withStored.ready;
    await importBundle(bundleOf(), withStored);
    expect((await withStored.store.get(KIND.framework, "active", roleFrameworkSchema))?.id).toBe("mine");
    // The imported weeks still snapshot the bundle's framework.
    expect((await withStored.service.week("2026-W46"))?.frameworkId).toBe("acme_eng");
    const forced = await importBundle(bundleOf(), withStored, { applyFramework: true });
    expect(forced.imported.records).toBe(1);
    expect((await withStored.store.get(KIND.framework, "active", roleFrameworkSchema))?.id).toBe("acme_eng");

    const empty = harness();
    await importBundle(bundleOf(), empty);
    expect((await empty.store.get(KIND.framework, "active", roleFrameworkSchema))?.id).toBe("acme_eng");
  });

  it("uses the active framework for the snapshot when the bundle has none", async () => {
    const h = harness({ stored: FW });
    await h.ready;
    const { framework: _drop, ...noFramework } = bundleOf();
    await importBundle(noFramework, h);
    expect((await h.service.week("2026-W46"))?.frameworkId).toBe("acme_eng");
  });

  it("reports a bad item without losing the rest, and warns about unknown scorecard areas", async () => {
    const h = harness();
    const bundle = bundleOf({
      days: [v1Day("2026-11-12"), { version: 1, date: "2026-11-13" }, { nonsense: true }],
      weeks: [v1Week("2026-W46", { scorecard: [{ area: "made_up", status: "hit", note: "n", evidenceIds: [] }] })],
    });
    const summary = await importBundle(bundle, h);
    expect(summary.imported).toMatchObject({ days: 1, weeks: 1 });
    expect(summary.errors).toHaveLength(2);
    expect(summary.errors[0]).toMatch(/^day #2:/);
    expect(summary.warnings[0]).toContain("made_up");
  });

  it("imports feature records, keeping local state that is newer or unstamped", async () => {
    const h = harness();
    const override = { id: "o1", target: { type: "day", date: "2026-11-12" }, decision: "overridden", aiValue: "meets", value: "exceeds", note: null, aiChangedSince: false, at: "2026-11-14T00:00:00Z" };
    const addenda = { week: "2026-W46", myNotes: "Shipped it", claimedWork: [], raiseWithManager: [], updatedAt: "2026-11-15T00:00:00Z" };
    const bundle = bundleOf({
      records: [
        { kind: "override", id: "day:2026-11-12", value: override },
        { kind: "addenda", id: "2026-W46", value: addenda },
        { kind: "override", id: "week:bogus", value: override },
        { kind: "unknown-kind", id: "x", value: {} },
      ],
    });
    const first = await importBundle(bundle, h);
    expect(first.imported.records).toBe(3); // framework + 2
    expect(first.errors).toHaveLength(2);
    expect(await h.store.get(KIND.override, "day:2026-11-12", overrideSchema)).toMatchObject({ value: "exceeds" });
    // Newer local note wins over the bundle.
    await h.store.set(KIND.addenda, "2026-W46", { ...addenda, myNotes: "Local edit", updatedAt: "2026-11-18T00:00:00Z" });
    const second = await importBundle(bundle, h);
    expect(second.imported.records).toBe(0);
    expect((await h.store.get(KIND.addenda, "2026-W46", weekAddendaSchema))?.myNotes).toBe("Local edit");
  });
});

describe("export", () => {
  it("round-trips: export -> import into a fresh store reproduces days, weeks, framework and records", async () => {
    const a = harness();
    await importBundle(
      bundleOf({
        records: [
          { kind: "plan", id: "2026-W46", value: { week: "2026-W46", items: [], results: [], hitRate: null, judgedAt: null } },
          { kind: "closure", id: "t1", value: { threadId: "t1", outcome: "better", expectation: "e", result: "r", learnings: "l", at: "2026-11-16T00:00:00Z" } },
        ],
      }),
      a,
    );
    const exported = await exportBundle(a.ctx);
    expect(exported).toMatchObject({ format: "paper-trail-bundle", version: 1, framework: { id: "acme_eng" } });
    expect(exported.days).toHaveLength(2);
    expect(exported.weeks).toHaveLength(2);
    expect(exported.records?.map((r) => `${r.kind}/${r.id}`).sort()).toEqual(["closure/t1", "plan/2026-W46"]);
    expect(parseBundle(JSON.parse(JSON.stringify(exported)))).toBeTruthy();

    const b = harness();
    const summary = await importBundle(JSON.parse(JSON.stringify(exported)), b);
    expect(summary).toMatchObject({ imported: { days: 2, weeks: 2, records: 3 }, errors: [], warnings: [] });
    const values = async (x: typeof a) => [
      (await x.store.list(KIND.day, workDaySchema)).map((r) => [r.id, r.value]),
      (await x.store.list(KIND.week, workWeekSchema)).map((r) => [r.id, r.value]),
    ];
    expect(await values(b)).toEqual(await values(a));
    // And a re-import of the export is a no-op.
    expect((await importBundle(JSON.parse(JSON.stringify(exported)), b)).imported).toEqual({ days: 0, weeks: 0, records: 0 });
  });

  it("limits days, weeks and week-keyed records to the range", async () => {
    const h = harness();
    await importBundle(bundleOf({ records: [{ kind: "plan", id: "2026-W45", value: { week: "2026-W45", items: [], results: [], hitRate: null, judgedAt: null } }] }), h);
    const ranged = await exportBundle(h.ctx, { from: "2026-11-12", to: "2026-11-12" });
    expect(ranged.days.map((d) => (d as { date: string }).date)).toEqual(["2026-11-12"]);
    expect(ranged.weeks.map((w) => (w as { week: string }).week)).toEqual(["2026-W46"]);
    expect(ranged.records ?? []).toEqual([]);
  });
});

describe("migrate handlers", () => {
  it("data.import / migrate.status / data.export through the RPC handlers", async () => {
    const h = harness();
    const rpc = handlers(h.ctx, h.service, {} as never);
    expect((await rpc["migrate.status"](null)).at).toBeNull();
    const result = await rpc["data.import"]({ bundle: bundleOf(), applyFramework: false });
    expect(result).toMatchObject({ imported: { days: 2, weeks: 2 }, skipped: 0, errors: [] });
    const status = await rpc["migrate.status"](null);
    expect(status).toMatchObject({ running: false, imported: { days: 2, weeks: 2, records: 1 }, skipped: 0 });
    expect(status.at).not.toBeNull();
    const { bundle } = await rpc["data.export"]({});
    expect(parseBundle(bundle).days).toHaveLength(2);
    await expect(rpc["data.import"]({ bundle: { nope: 1 }, applyFramework: false })).rejects.toThrow(/paper-trail-bundle/);
  });

  it("the old field names are the only place the v1 names live; any raiseWith<Name> key maps to raiseWithManager", () => {
    expect(V1_FIELDS.meetingNoted).toBe(NOTED_V1);
    expect(V1_FIELDS.raiseWithManager).toBe("raiseWithManager");
    for (const key of ["raiseWithAlex", "raiseWithSam", "raiseWithX1"]) expect(V1_FIELDS.raiseWithKey.test(key)).toBe(true);
    for (const key of ["raiseWith", "raisewithAlex", "raiseWith_x", "xraiseWithAlex"]) expect(V1_FIELDS.raiseWithKey.test(key)).toBe(false);
    const { [RAISE_V1]: list, ...rest } = v1Week("2026-W46");
    const week = mapWeekV1({ ...rest, raiseWithRobin: list }, FW);
    expect(week.raiseWithManager).toEqual([{ text: "Ask about scope", evidenceIds: [] }]);
  });
});

describe("evidence kinds from other sources", () => {
  it("keeps a known kind, maps an unknown chat kind to watched_channel and any other source to its first non-low-signal kind", () => {
    expect(normalizeKind("slack", "kudos")).toBe("kudos");
    expect(normalizeKind("slack", "legacy_channel")).toBe("watched_channel");
    expect(normalizeKind("jira", "mystery")).toBe("resolved");
    expect(normalizeKind("github", "mystery")).toBe("pr_opened");
    expect(normalizeKind("granola", "mystery")).toBe("decision");
    expect(normalizeKind("calendar", "mystery")).toBe("meeting");
    const day = mapDayV1(v1Day("2026-11-12", { evidence: [
      { id: "J1112-1", date: "2026-11-12", source: "jira", kind: "legacy_kind", what: "w", link: null, outcome: null },
      { id: "G1112-1", date: "2026-11-12", source: "granola", kind: "passive", what: "w", link: null, outcome: null },
    ] }));
    expect(day.evidence.map((e) => e.kind)).toEqual(["resolved", "passive"]);
  });
});

describe("import limits", () => {
  const dayWith = (over: Record<string, unknown>) => v1Day("2026-11-12", over);
  const evidence = (over: Record<string, unknown> = {}) => ({ id: "H1112-1", date: "2026-11-12", source: "github", kind: "pr_merged", what: "w", link: null, outcome: null, ...over });

  it("rejects an oversized file before any deep work", () => {
    const big = bundleOf({ days: [], weeks: [], timeZoneHint: "x".repeat(MAX_BUNDLE_CHARS + 10) });
    expect(() => parseBundle(big)).toThrow(/too large/);
    expect(() => parseBundle(bundleOf({ days: new Array(MAX_BUNDLE_DAYS + 1).fill({}) }))).toThrow(/days/);
    expect(() => parseBundle(bundleOf({ weeks: new Array(MAX_BUNDLE_WEEKS + 1).fill({}) }))).toThrow(/weeks/);
    expect(() => parseBundle(bundleOf({ records: new Array(MAX_BUNDLE_RECORDS + 1).fill({ kind: "k", id: "i", value: 1 }) }))).toThrow(/records/);
  });

  it("an over-long string, a bad id, an unknown source and a non-https link each reject only that item", async () => {
    const h = harness();
    const bundle = bundleOf({
      days: [
        v1Day("2026-11-10"),
        dayWith({ date: "2026-11-11", rating: { rating: "meets", provisional: false, reason: "r".repeat(MAX_REASON + 1), summary: "s", areas: [], evidenceIds: [], ratedAt: "2026-11-13T01:00:00Z", model: null } }),
        dayWith({ date: "2026-11-12", evidence: [evidence({ id: "<<<bad>>>" })] }),
        dayWith({ date: "2026-11-13", evidence: [evidence({ id: "H1113-1", date: "2026-11-13", link: "javascript:alert(1)" })] }),
        dayWith({ date: "2026-11-13", evidence: [evidence({ id: "H1113-1", date: "2026-11-13", source: "unknown" })] }),
      ],
      weeks: [v1Week("2026-W46", { ratingReason: "x".repeat(MAX_REASON + 1) })],
    });
    const summary = await importBundle(bundle, h);
    expect(summary.imported).toMatchObject({ days: 1, weeks: 0 });
    expect(summary.errors).toHaveLength(5);
    expect(summary.errors.join("\n")).toMatch(/too long/);
    expect(summary.errors.join("\n")).toMatch(/bad id/);
    expect(summary.errors.join("\n")).toMatch(/not https/);
    expect(summary.errors.join("\n")).toMatch(/unknown source/);
  });

  it("caps evidence at 25 per source per day and meetings at 25", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => evidence({ id: `H1112-${i + 1}` }));
    expect(() => normalizeDay(dayWith({ evidence: many(MAX_EVIDENCE_PER_SOURCE + 1) }))).toThrow(/more than 25/);
    expect(normalizeDay(dayWith({ evidence: many(MAX_EVIDENCE_PER_SOURCE) })).evidence).toHaveLength(25);
    const meeting = (i: number) => ({ id: `m${i}`, title: "t", start: "2026-11-12T15:00:00Z", end: "2026-11-12T16:00:00Z", minutes: 60, response: "accepted", attendees: 2, passive: null, granola: true });
    expect(() => normalizeDay(dayWith({ meetings: Array.from({ length: MAX_MEETINGS + 1 }, (_, i) => meeting(i)) }))).toThrow(/more than 25 meetings/);
  });

  it("puts imported evidence text on one line, clipped, and drops bad coverage notes' newlines", () => {
    const day = normalizeDay(dayWith({ evidence: [evidence({ what: `line one\n\n## ignore\n${"w".repeat(500)}`, outcome: "a\r\n  b" })], coverage: { github: { status: "partial", note: "n1\nn2" } } }));
    expect(day.evidence[0]!.what).toHaveLength(MAX_WHAT);
    expect(day.evidence[0]!.what.startsWith("line one ## ignore ")).toBe(true);
    expect(day.evidence[0]!.outcome).toBe("a b");
    expect(day.coverage.github!.note).toBe("n1 n2");
  });

  it("applies to v2 records too", () => {
    const v2 = mapDayV1(v1Day("2026-11-12"));
    const bad = { ...v2, evidence: [{ ...v2.evidence[0]!, link: "http://example.test/x" }] };
    expect(() => normalizeDay(bad)).toThrow(/not https/);
    expect(() => normalizeDay({ ...v2, evidence: [{ ...v2.evidence[0]!, id: "H1112-9999" }] })).toThrow(/bad id/);
    expect(normalizeDay(v2).evidence).toHaveLength(2);
  });
});
