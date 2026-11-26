import { describe, expect, it } from "vitest";
import { weekDates } from "../lib/engine/dates";
import { createRegistry, runGridContributors, runWeekHooks, type FeatureCtx } from "../lib/engine/extensions";
import { DEFAULT_FRAMEWORK } from "../lib/framework/default";
import { register } from "../lib/features/drift";
import { weekDrift, weekMix } from "../lib/features/drift/mix";
import { driftSnapshot, statusOf } from "../lib/features/drift/snapshot";
import { handlers } from "../lib/handlers/drift";
import { DEFAULT_SETTINGS } from "../lib/settings";
import { createMemoryStore } from "../lib/storage/memory";
import { KIND } from "../lib/storage/port";
import { driftSnapshotSchema, gridV2Schema, weekMixSchema, workWeekSchema, type AllocationTargets, type WeekMix, type WorkDay, type WorkWeek } from "../lib/types";

const NOW = new Date("2026-11-13T22:00:00Z");
const day = (date: string, areas: string[] | null): WorkDay => ({
  version: 2, date, week: "2026-W46", capturedAt: "2026-11-13T00:00:00Z", coverage: {}, meetings: [], meetingCount: 0, meetingMinutes: 0, evidence: [],
  rating: areas === null ? null : { rating: "meets", provisional: false, reason: "r", summary: "s", areas, evidenceIds: [], ratedAt: "2026-11-13T00:00:00Z", model: null },
});
const week = (id: string, scorecard: WorkWeek["scorecard"] = []): WorkWeek =>
  workWeekSchema.parse({
    version: 2, week: id, from: weekDates(id)[0], to: weekDates(id)[4], generatedAt: "2026-11-13T00:00:00Z", model: null, final: true, rating: "meets", ratingReason: "r",
    threeLines: [], days: [], daysWorked: 5, scorecard, meetings: { count: 0, hours: 0, pctOfWeek: 0, passiveCount: 0, topSinks: [] }, reflection: { goodWeek: true, text: "" }, coverage: {},
  });
const sum = (r: Record<string, number>) => Object.values(r).reduce((s, v) => s + v, 0);
const targets = (t: Record<string, number>, over: Partial<AllocationTargets> = {}): AllocationTargets => ({
  version: 1, frameworkId: "default", targets: t, windowWeeks: 4, thresholds: { watch: 10, off: 20 }, updatedAt: "2026-11-01T00:00:00Z", ...over,
});
const mixOf = (id: string, actual: Record<string, number>): WeekMix => ({ week: id, daysCounted: 5, actual, scorecard: {}, drift: null });

describe("weekMix", () => {
  it("splits each rated day equally over its areas and sums to 1", () => {
    const days = [day("2026-11-09", ["delivery"]), day("2026-11-10", ["delivery", "mentorship"]), day("2026-11-11", ["technical_design"]), day("2026-11-12", null)];
    const mix = weekMix(week("2026-W46"), days, DEFAULT_FRAMEWORK);
    expect(mix.daysCounted).toBe(3);
    expect(sum(mix.actual)).toBeCloseTo(1, 2);
    expect(mix.actual.delivery).toBeCloseTo(0.5, 3);
    expect(mix.actual.mentorship).toBeCloseTo(0.167, 3);
    expect(mix.actual.technical_design).toBeCloseTo(0.333, 3);
    expect(mix.actual.direction).toBe(0);
  });
  it("resolves renamed areas and drops unknown ones", () => {
    const fw = { ...DEFAULT_FRAMEWORK, areaAliases: { shipping: "delivery" } };
    const mix = weekMix(week("2026-W46"), [day("2026-11-09", ["shipping", "unknown_area"])], fw);
    expect(mix.actual.delivery).toBe(1);
    expect(Object.keys(mix.actual)).not.toContain("unknown_area");
  });
  it("falls back to the scorecard when no day has areas (hit 1, partial 0.5, missed 0, normalised)", () => {
    const w = week("2026-W46", [
      { area: "delivery", status: "hit", note: "", evidenceIds: [] },
      { area: "mentorship", status: "partial", note: "", evidenceIds: [] },
      { area: "direction", status: "missed", note: "", evidenceIds: [] },
    ]);
    const mix = weekMix(w, [day("2026-11-09", [])], DEFAULT_FRAMEWORK);
    expect(mix.daysCounted).toBe(0);
    expect(mix.actual.delivery).toBeCloseTo(0.667, 3);
    expect(mix.actual.mentorship).toBeCloseTo(0.333, 3);
    expect(mix.actual.direction).toBe(0);
    expect(sum(mix.actual)).toBeCloseTo(1, 2);
    expect(mix.scorecard).toEqual({ delivery: "hit", mentorship: "partial", direction: "missed" });
  });
  it("has no signal (empty actual, null drift) with neither areas nor a useful scorecard", () => {
    const mix = weekMix(week("2026-W46"), [], DEFAULT_FRAMEWORK, { delivery: 100 });
    expect(mix.actual).toEqual({});
    expect(mix.drift).toBeNull();
  });
  it("fills the week's own drift when targets are given", () => {
    const mix = weekMix(week("2026-W46"), [day("2026-11-09", ["delivery"])], DEFAULT_FRAMEWORK, { delivery: 40, mentorship: 60 });
    expect(mix.drift).toBe(60);
  });
});

describe("driftSnapshot", () => {
  const even = { a_one: 50, b_two: 50 };
  it("scores 0 and aligned when actual equals target", () => {
    const s = driftSnapshot("2026-W46", [mixOf("2026-W46", { a_one: 0.5, b_two: 0.5 })], targets(even), NOW.toISOString())!;
    expect(s.score).toBe(0);
    expect(s.status).toBe("aligned");
    expect(s.biggestOver).toBeNull();
    expect(s.biggestUnder).toBeNull();
  });
  it("scores large when actual and target are disjoint", () => {
    const s = driftSnapshot("2026-W46", [mixOf("2026-W46", { a_one: 1, b_two: 0 })], targets({ b_two: 100 }), NOW.toISOString())!;
    expect(s.score).toBe(100);
    expect(s.status).toBe("off");
    expect(s.perArea).toEqual({ a_one: 100, b_two: -100 });
    expect(s.biggestOver).toBe("a_one");
    expect(s.biggestUnder).toBe("b_two");
  });
  it("reports signed pp per area, rounded to 0.1, and the max as the score", () => {
    const s = driftSnapshot("2026-W46", [mixOf("2026-W46", { a_one: 0.683, b_two: 0.317 })], targets(even), "t")!;
    expect(s.perArea).toEqual({ a_one: 18.3, b_two: -18.3 });
    expect(s.score).toBe(18.3);
    expect(s.status).toBe("watch");
    expect(s.actual.a_one).toBe(68.3);
  });
  it("averages the weeks in the window equally, ignoring weeks with no data", () => {
    const mixes = [mixOf("2026-W44", { a_one: 1, b_two: 0 }), mixOf("2026-W45", { a_one: 0, b_two: 1 }), mixOf("2026-W46", {}), mixOf("2026-W47", { a_one: 0.5, b_two: 0.5 })];
    const s = driftSnapshot("2026-W47", mixes, targets(even), "t")!;
    expect(s.actual).toEqual({ a_one: 50, b_two: 50 });
    expect(s.score).toBe(0);
  });
  it("is null without any data", () => {
    expect(driftSnapshot("2026-W46", [mixOf("2026-W46", {})], targets(even), "t")).toBeNull();
  });
  it("applies the watch and off thresholds at the boundary", () => {
    const th = { watch: 10, off: 20 };
    expect([statusOf(9.9, th), statusOf(10, th), statusOf(19.9, th), statusOf(20, th)]).toEqual(["aligned", "watch", "watch", "off"]);
  });
  it("weekDrift is the max absolute gap in pp", () => {
    expect(weekDrift({ a_one: 0.7, b_two: 0.3 }, { a_one: 50, b_two: 50 })).toBe(20);
  });
});

function harness() {
  const store = createMemoryStore();
  const published = { n: 0 };
  const ctx: FeatureCtx = {
    store, settings: () => ({ ...DEFAULT_SETTINGS, timeZone: "America/New_York" }), framework: async () => DEFAULT_FRAMEWORK,
    runner: { status: () => ({ running: 0, queued: 0 }), runJob: (() => { throw new Error("no jobs"); }) as never },
    log: { info: () => undefined, warn: () => undefined }, publish: () => void (published.n += 1), now: () => NOW,
  };
  const reg = createRegistry();
  register(reg);
  return { store, ctx, reg, published };
}
const T6 = { delivery: 40, technical_design: 15, quality_reliability: 15, collaboration: 10, mentorship: 10, direction: 10 };

describe("drift hook, contributor and handler", () => {
  it("writes the mix and the snapshot for a saved week", async () => {
    const { store, ctx, reg, published } = harness();
    await store.set(KIND.targets, "active", targets(T6));
    for (const d of weekDates("2026-W46")) await store.set(KIND.day, d, day(d, ["delivery"]));
    await runWeekHooks(reg, week("2026-W46"), ctx);
    const mix = await store.get(KIND.mix, "2026-W46", weekMixSchema);
    expect(mix?.actual.delivery).toBe(1);
    expect(mix?.drift).toBe(60);
    const snap = await store.get(KIND.drift, "2026-W46", driftSnapshotSchema);
    expect(snap?.score).toBe(60);
    expect(snap?.status).toBe("off");
    expect(snap?.biggestOver).toBe("delivery");
    expect(snap?.biggestUnder).toBe("quality_reliability"); // ties (15 vs 15) go to the first key alphabetically
    expect(published.n).toBeGreaterThan(0);
  });
  it("writes only the mix when there are no targets", async () => {
    const { store, ctx, reg } = harness();
    await store.set(KIND.day, "2026-11-09", day("2026-11-09", ["delivery"]));
    await runWeekHooks(reg, week("2026-W46"), ctx);
    expect((await store.get(KIND.mix, "2026-W46", weekMixSchema))?.drift).toBeNull();
    expect(await store.get(KIND.drift, "2026-W46", driftSnapshotSchema)).toBeNull();
  });
  it("sets markers.drift per week from the window", async () => {
    const { store, ctx, reg } = harness();
    await store.set(KIND.targets, "active", targets({ a_one: 50, b_two: 50 }, { windowWeeks: 1 }));
    await store.set(KIND.mix, "2026-W44", mixOf("2026-W44", { a_one: 0.5, b_two: 0.5 }));
    await store.set(KIND.mix, "2026-W45", mixOf("2026-W45", { a_one: 0.65, b_two: 0.35 }));
    await store.set(KIND.mix, "2026-W46", mixOf("2026-W46", { a_one: 0.9, b_two: 0.1 }));
    const mk = (w: string) => ({ week: w, from: weekDates(w)[0]!, label: w, monthLabel: null, rating: null, final: true, cells: [] });
    const grid = gridV2Schema.parse({
      today: "2026-11-13", currentWeek: "2026-W46", weeks: ["2026-W44", "2026-W45", "2026-W46", "2026-W47"].map(mk), status: { running: null, queued: [], lastError: null },
      areas: [], lensAvailability: { rating: true, area: true, meeting: true, evidence: true, plan: false }, timeZone: "America/New_York", workdayHours: 7.5,
    });
    await runGridContributors(reg, grid, ctx);
    expect(grid.weeks.map((w) => w.markers.drift)).toEqual([null, "watch", "off", null]);
  });
  it("drift.get recomputes against the current targets and reports the method", async () => {
    const { store, ctx } = harness();
    await store.set(KIND.targets, "active", targets({ a_one: 50, b_two: 50 }, { windowWeeks: 2 }));
    await store.set(KIND.mix, "2026-W45", mixOf("2026-W45", { a_one: 0.9, b_two: 0.1 }));
    await store.set(KIND.mix, "2026-W46", mixOf("2026-W46", { a_one: 0.5, b_two: 0.5 }));
    const out = await handlers(ctx, null as never, null as never)["drift.get"]({ weeks: 4 });
    expect(out.method).toBe("day_areas");
    expect(out.mix.map((m) => m.week)).toEqual(["2026-W45", "2026-W46"]);
    expect(out.mix[0]!.drift).toBe(40);
    expect(out.snapshot?.week).toBe("2026-W46");
    expect(out.snapshot?.score).toBe(20);
  });
  it("drift.get has a null snapshot without targets", async () => {
    const { store, ctx } = harness();
    await store.set(KIND.mix, "2026-W46", mixOf("2026-W46", { a_one: 1 }));
    const out = await handlers(ctx, null as never, null as never)["drift.get"]({ weeks: 4 });
    expect(out.snapshot).toBeNull();
    expect(out.mix).toHaveLength(1);
  });
});
