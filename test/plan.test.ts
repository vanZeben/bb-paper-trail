import { describe, expect, it } from "vitest";
import { rpcContract } from "../lib/contract";
import { buildGrid } from "../lib/engine/grid";
import { createRegistry, type FeatureCtx, type PromptCtx } from "../lib/engine/extensions";
import { handlers as planHandlers } from "../lib/handlers/plan";
import { register } from "../lib/features/plan";
import { inferredItems, isRef, validateRefs, validateWeekScan, type Proposal, type ScanGoal } from "../lib/features/plan/auto";
import { calibrationNote, planAccuracy, unplannedShare, validateRetro } from "../lib/features/plan/marks";
import { validateGoalProgress } from "../lib/features/goals/progress";
import { advancedByDate, buildItems, carryOverCandidates, emptyPlan, hitRate, planStats, planSummary, pushItems, validatePlanResults } from "../lib/features/plan/logic";
import { planRules } from "../lib/features/plan/rules";
import { planItem, weekPlan } from "./fixtures";
import { DEFAULT_FRAMEWORK } from "../lib/framework/default";
import { DEFAULT_SETTINGS } from "../lib/settings";
import { createMemoryStore } from "../lib/storage/memory";
import { KIND } from "../lib/storage/port";
import { LOW_SIGNAL_KINDS } from "../lib/capture/sources";
import { weekPlanSchema, workWeekSchema, type PlanItem, type PlanResult, type WeekPlan, type WorkWeek } from "../lib/types";

const weekRecord = (evidence: unknown[]): WorkWeek =>
  workWeekSchema.parse({
    version: 2, week: "2026-W46", from: "2026-11-09", to: "2026-11-13", generatedAt: NOW, model: null, final: true, rating: "meets", ratingReason: "r", threeLines: [], days: [], daysWorked: 5,
    scorecard: [], meetings: { count: 0, hours: 0, pctOfWeek: 0, passiveCount: 0 }, reflection: { goodWeek: true, text: "t" }, coverage: {}, evidence,
  });

const NOW = "2026-11-13T15:00:00Z";
let n = 0;
const seq = () => `id${++n}`;
const item = (id: string, over: Partial<PlanItem> = {}): PlanItem => planItem({ id, text: `Item ${id}`, createdAt: NOW, ...over });
const res = (itemId: string, status: PlanResult["status"], evidenceIds: string[] = []): PlanResult => ({ itemId, status, note: "", evidenceIds });
const plan = (week: string, items: PlanItem[], results: PlanResult[] = [], judged = results.length > 0): WeekPlan => weekPlan({ week, items, results, hitRate: judged ? hitRate(items, results) : null, judgedAt: judged ? NOW : null });

describe("validatePlanResults", () => {
  const ctx = { itemIds: new Set(["a", "b", "c"]), evidenceIds: new Set(["J1109-1", "G1110-1"]) };
  it("drops unknown item ids and unknown evidence ids", () => {
    const out = validatePlanResults({ plan: [{ itemId: "zzz", status: "done", evidenceIds: ["J1109-1"] }, { itemId: "a", status: "done", note: "ok", evidenceIds: ["J1109-1", "X9999-9"] }] }, ctx);
    expect(out).toEqual([{ itemId: "a", status: "done", note: "ok", evidenceIds: ["J1109-1"] }]);
  });
  it("downgrades done without evidence to partial, including when every id was unknown", () => {
    const out = validatePlanResults({ plan: [{ itemId: "a", status: "done", evidenceIds: [] }, { itemId: "b", status: "done", evidenceIds: ["nope"] }, { itemId: "c", status: "not_done" }] }, ctx);
    expect(out.map((r) => r.status)).toEqual(["partial", "partial", "not_done"]);
  });
  it("ignores bad statuses, duplicate ids and a missing or non-array plan", () => {
    expect(validatePlanResults({ plan: [{ itemId: "a", status: "great" }, { itemId: "b", status: "partial" }, { itemId: "b", status: "done", evidenceIds: ["J1109-1"] }] }, ctx)).toHaveLength(1);
    expect(validatePlanResults({}, ctx)).toEqual([]);
    expect(validatePlanResults({ plan: "x" }, ctx)).toEqual([]);
  });
});

describe("hit rate", () => {
  it("is (done + 0.5 partial) / (items - dropped)", () => {
    const items = ["a", "b", "c", "d"].map((i) => item(i));
    expect(hitRate(items, [res("a", "done", ["x"]), res("b", "partial"), res("c", "not_done"), res("d", "dropped")])).toBeCloseTo(1.5 / 3);
  });
  it("counts an item with no result as missed, and is null with nothing to judge", () => {
    expect(hitRate([item("a"), item("b")], [res("a", "done", ["x"])])).toBe(0.5);
    expect(hitRate([], [])).toBeNull();
    expect(hitRate([item("a")], [res("a", "dropped")])).toBeNull();
  });
  it("planStats pools weeks and lists the weeks that have items", () => {
    const w1 = plan("2026-W44", [item("a"), item("b")], [res("a", "done", ["x"]), res("b", "not_done")]);
    const w2 = plan("2026-W45", [item("c", { week: "2026-W45" })], [res("c", "partial")]);
    const w3 = plan("2026-W46", [item("d")]);
    const s = planStats([w3, w1, w2, emptyPlan("2026-W43")]);
    expect(s.byWeek).toEqual([{ week: "2026-W44", hitRate: 0.5 }, { week: "2026-W45", hitRate: 0.5 }, { week: "2026-W46", hitRate: null }]);
    expect(s.hitRate).toBeCloseTo(1.5 / 3);
  });
});

describe("carry-over", () => {
  const prev = plan("2026-W45", [item("a", { week: "2026-W45", carryCount: 1, carriedFrom: "z" }), item("b", { week: "2026-W45" }), item("c", { week: "2026-W45" })], [res("a", "partial"), res("b", "done", ["x"]), res("c", "not_done")]);
  it("offers not_done and partial items with carryCount + 1", () => {
    const c = carryOverCandidates(prev);
    expect(c.map((x) => [x.fromId, x.carryCount, x.carriedFrom])).toEqual([["a", 2, "a"], ["c", 1, "c"]]);
  });
  it("an unjudged week offers nothing; a judged item without a result counts as not done", () => {
    expect(carryOverCandidates(plan("2026-W45", [item("a")]))).toEqual([]);
    const judged = { ...plan("2026-W45", [item("a")], [res("x", "done")]), judgedAt: NOW };
    expect(carryOverCandidates(judged)).toHaveLength(1);
  });
  it("buildItems links a carried item by previous id, or by identical text, and counts", () => {
    const out = buildItems("2026-W46", [{ id: "a", text: "edited text" }, { text: "ITEM c" }, { text: "brand new" }, { text: "   " }], [], prev, NOW, seq);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ carriedFrom: "a", carryCount: 2, text: "edited text", week: "2026-W46" });
    expect(out[1]).toMatchObject({ carriedFrom: "c", carryCount: 1 });
    expect(out[2]).toMatchObject({ carriedFrom: null, carryCount: 0, source: "manual" });
    expect(new Set(out.map((o) => o.id)).size).toBe(3);
  });
  it("keeps an existing item's provenance, assigns ids to new ones, and caps at 7", () => {
    const ext = item("e", { source: "external", externalRef: "T-1" });
    const out = buildItems("2026-W46", [{ id: "e", text: "renamed" }, ...Array.from({ length: 9 }, (_, i) => ({ text: `n${i}` }))], [ext], null, NOW, seq);
    expect(out).toHaveLength(7);
    expect(out[0]).toMatchObject({ id: "e", source: "external", externalRef: "T-1", text: "renamed" });
  });
  it("planStats lists unfinished chains with their first week", () => {
    const w1 = plan("2026-W44", [item("a", { week: "2026-W44" })], [res("a", "not_done")]);
    const w2 = plan("2026-W45", [item("b", { week: "2026-W45", carriedFrom: "a", carryCount: 1 })], [res("b", "partial")]);
    const w3 = plan("2026-W46", [item("c", { carriedFrom: "b", carryCount: 2 }), item("d", { carriedFrom: "q", carryCount: 1 })], [res("c", "not_done"), res("d", "done", ["x"])]);
    expect(planStats([w1, w2, w3]).carriedOver).toEqual([{ text: "Item c", carryCount: 2, firstWeek: "2026-W44" }]);
  });
});

describe("push", () => {
  it("dedupes by externalRef and respects the cap", () => {
    const first = pushItems("2026-W46", [], [{ text: "A", externalRef: "T-1" }, { text: "B", externalRef: "T-2" }], NOW, seq);
    expect(first.items.map((i) => [i.source, i.externalRef])).toEqual([["external", "T-1"], ["external", "T-2"]]);
    const again = pushItems("2026-W46", first.items, [{ text: "A again", externalRef: "T-1" }, { text: "C", externalRef: "T-3" }], NOW, seq);
    expect(again.added).toBe(1);
    expect(again.skipped).toBe(1);
    expect(again.items).toHaveLength(3);
    const full = pushItems("2026-W46", Array.from({ length: 7 }, (_, i) => item(`f${i}`)), [{ text: "X", externalRef: "T-9" }], NOW, seq);
    expect(full.items).toHaveLength(7);
  });
});

describe("prompt text and summary", () => {
  it("lists the items with ids and is empty without items", () => {
    expect(planRules([], (k) => k)).toBe("");
    expect(planRules([item("a", { area: "delivery" })], () => "Delivery")).toContain("[a] Item a (area: Delivery)");
  });
  it("summarises for the Graph prompt", () => {
    expect(planSummary({ items: [], results: [] })).toBeNull();
    expect(planSummary({ items: [item("a"), item("b"), item("c")], results: [res("a", "done", ["x"]), res("b", "not_done")] })).toBe("3 intentions · 1 advanced so far");
  });
});

function harness() {
  const store = createMemoryStore();
  const logs: string[] = [];
  const ctx: FeatureCtx = {
    store,
    settings: () => ({ ...DEFAULT_SETTINGS, timeZone: "America/New_York" }),
    framework: async () => DEFAULT_FRAMEWORK,
    runner: {} as FeatureCtx["runner"],
    log: { info: (m) => void logs.push(m), warn: (m) => void logs.push(m) },
    publish: () => undefined,
    now: () => new Date(NOW),
  };
  const reg = createRegistry();
  register(reg);
  return { store, ctx, reg, logs };
}

describe("registered extensions", () => {
  it("the prompt extension lists items, then validates with the week's evidence", async () => {
    const { store, reg } = harness();
    await store.set(KIND.plan, "2026-W46", plan("2026-W46", [item("a"), item("b")]));
    await store.set(KIND.day, "2026-11-09", { version: 2, date: "2026-11-09", week: "2026-W46", capturedAt: NOW, coverage: {}, meetings: [], meetingCount: 0, meetingMinutes: 0, evidence: [{ id: "J1109-1", date: "2026-11-09", source: "jira", kind: "ticket", what: "x", link: null, outcome: null, area: null }], rating: null });
    const ext = reg.prompts[0]!;
    const pctx: PromptCtx = { week: "2026-W46", dates: ["2026-11-09", "2026-11-10"], framework: DEFAULT_FRAMEWORK, settings: DEFAULT_SETTINGS, store };
    expect(await ext.weekRules!(pctx)).toContain("[b]");
    expect(await ext.weekReplyExample!(pctx)).toContain(`"plan":[{"itemId"`);
    const out = ext.validateWeekExtra!({ plan: [{ itemId: "a", status: "done", evidenceIds: ["J1109-1", "J1109-9"] }, { itemId: "q", status: "done" }] }, pctx);
    expect(out).toEqual([{ itemId: "a", status: "done", note: "", evidenceIds: ["J1109-1"] }]);
  });

  it("the prompt extension adds nothing for a week with no plan", async () => {
    const { store, reg } = harness();
    const ext = reg.prompts[0]!;
    const pctx: PromptCtx = { week: "2026-W46", dates: [], framework: DEFAULT_FRAMEWORK, settings: DEFAULT_SETTINGS, store };
    expect(await ext.weekRules!(pctx)).toBe("");
    expect(await ext.weekReplyExample!(pctx)).toBe("");
    expect(ext.validateWeekExtra!({ plan: [{ itemId: "a", status: "done" }] }, pctx)).toEqual([]);
  });

  it("the week hook copies results and the hit rate into the plan record", async () => {
    const { store, ctx, reg } = harness();
    await store.set(KIND.plan, "2026-W46", plan("2026-W46", [item("a"), item("b")]));
    const week = { week: "2026-W46", ext: { plan: [res("a", "done", ["J1109-1"]), res("gone", "done", ["x"])] }, plan: [] } as unknown as WorkWeek;
    await reg.weekHooks[0]!.afterWeekSaved(week, ctx);
    const saved = (await store.list(KIND.plan, weekPlanSchema))[0]!.value;
    expect(saved.results).toEqual([res("a", "done", ["J1109-1"])]);
    expect(saved.hitRate).toBe(0.5);
    expect(saved.judgedAt).toBe(new Date(NOW).toISOString());
  });
});

describe("grid contributor", () => {
  it("sets planAdvanced per date, the week's hit rate and the lens availability", async () => {
    const { store, ctx, reg } = harness();
    const status = { running: null, queued: [], lastError: null };
    const grid = buildGrid({ version: 2, days: {}, weeks: {} }, "2026-11-13", 4, status, { areas: [], timeZone: "America/New_York", workdayHours: 8 });
    expect(grid.lensAvailability.plan).toBe(false);
    await reg.grid[0]!.contribute(grid, ctx);
    expect(grid.lensAvailability.plan).toBe(false);

    const p = plan("2026-W46", [item("a"), item("b"), item("c")], [res("a", "done", ["J1109-1", "G1109-2"]), res("b", "partial", ["G1110-1"]), res("c", "not_done")]);
    await store.set(KIND.plan, "2026-W46", p);
    const evidence = [{ id: "J1109-1", date: "2026-11-09" }, { id: "G1109-2", date: "2026-11-09" }, { id: "G1110-1", date: "2026-11-10" }].map((e) => ({ ...e, source: "x", kind: "k", what: "w", link: null, outcome: null, area: null }));
    await store.set(KIND.week, "2026-W46", weekRecord(evidence));
    await reg.grid[0]!.contribute(grid, ctx);
    expect(grid.lensAvailability.plan).toBe(true);
    const w = grid.weeks.find((x) => x.week === "2026-W46")!;
    expect(w.markers.planHitRate).toBe(p.hitRate);
    expect(w.cells.map((c) => c.planAdvanced)).toEqual([1, 1, 0, 0, 0]);
    expect(grid.weeks.find((x) => x.week === "2026-W45")!.cells.every((c) => c.planAdvanced === null)).toBe(true);
    expect(advancedByDate(p.results, evidence)).toEqual(new Map([["2026-11-09", 1], ["2026-11-10", 1]]));
  });
});

describe("buildItems ids", () => {
  it("gives a repeated existing id a fresh one", () => {
    let k = 0;
    const out = buildItems("2026-W46", [{ id: "a", text: "One" }, { id: "a", text: "Two" }, { id: "a", text: "Three" }], [item("a")], null, NOW, () => `n${++k}`);
    expect(out.map((i) => i.id)).toEqual(["a", "n1", "n2"]);
    expect(new Set(out.map((i) => i.id)).size).toBe(3);
  });
});

describe("plan handlers", () => {
  const make = () => {
    const h = harness();
    const api = planHandlers(h.ctx, {} as never, {} as never);
    return { ...h, api };
  };
  it("plan.set gives ids, carries over from last week and recomputes a judged hit rate", async () => {
    const { store, api } = make();
    await store.set(KIND.plan, "2026-W45", plan("2026-W45", [item("a", { week: "2026-W45" }), item("b", { week: "2026-W45" })], [res("a", "done", ["x"]), res("b", "not_done")]));
    const got = await api["plan.set"]({ week: "2026-W46", items: [{ id: "b", text: "Item b" }, { text: "Fresh" }] });
    expect(got.items).toHaveLength(2);
    expect(got.items[0]).toMatchObject({ carriedFrom: "b", carryCount: 1 });
    expect(got.items.every((i) => i.id !== "")).toBe(true);
    expect((await api["plan.get"]({ week: "2026-W46" })).items).toHaveLength(2);
    expect(await api["plan.get"]({ week: "2026-W40" })).toMatchObject({ items: [], hitRate: null });
  });
  it("plan.set nulls an area outside the active framework", async () => {
    const { api } = make();
    const real = DEFAULT_FRAMEWORK.areas[0]!.key;
    const got = await api["plan.set"]({ week: "2026-W46", items: [{ text: "A", area: real }, { text: "B", area: "not_an_area" }, { text: "C", area: null }] });
    expect(got.items.map((i) => i.area)).toEqual([real, null, null]);
  });
  it("plan.set contract takes only slug areas", () => {
    const input = (rpcContract as any)["plan.set"].input;
    expect(input.safeParse({ week: "2026-W46", items: [{ text: "A", area: "delivery" }] }).success).toBe(true);
    expect(input.safeParse({ week: "2026-W46", items: [{ text: "A", area: null }] }).success).toBe(true);
    expect(input.safeParse({ week: "2026-W46", items: [{ text: "A", area: "Not A Slug!" }] }).success).toBe(false);
  });
  it("plan.push dedupes by externalRef across calls", async () => {
    const { api } = make();
    await api["plan.push"]({ week: "2026-W46", items: [{ text: "Ship it", externalRef: "X-1" }] });
    await api["plan.push"]({ week: "2026-W46", items: [{ text: "Ship it", externalRef: "X-1" }, { text: "Other", externalRef: "X-2" }] });
    const p = await api["plan.get"]({ week: "2026-W46" });
    expect(p.items.map((i) => i.externalRef)).toEqual(["X-1", "X-2"]);
  });
  it("plan.stats covers the window ending at the current week", async () => {
    const { store, api } = make();
    await store.set(KIND.plan, "2026-W45", plan("2026-W45", [item("a", { week: "2026-W45" })], [res("a", "done", ["x"])]));
    await store.set(KIND.plan, "2026-W30", plan("2026-W30", [item("z", { week: "2026-W30" })], [res("z", "not_done")]));
    const s = await api["plan.stats"]({ weeks: 12 });
    expect(s.byWeek).toEqual([{ week: "2026-W45", hitRate: 1 }]);
    expect(s.hitRate).toBe(1);
  });
});

describe("validateWeekScan", () => {
  const WEEK = "2026-W46"; // Mon 2026-11-09 .. Sun 2026-11-15
  const keys = ["delivery", "mentorship"];
  const goals: ScanGoal[] = [
    { id: "g1", text: "Cut latency", area: null, tasks: [{ id: "t1", text: "Ship limiter", ref: "ACME-12", status: "open" }] },
    { id: "g2", text: "Mentor", area: null, tasks: [] },
  ];
  const ctx = { week: WEEK, areaKeys: keys, goals };
  const c = (over: Record<string, unknown> = {}) => ({ text: "Ship the limiter", doneWhen: "PR merged", area: "delivery", kind: "deliver", refs: [{ kind: "ticket", label: "ACME-12", url: "ACME-12" }], ...over });
  const scan = (commitments: unknown[], extra: Record<string, unknown> = {}) => validateWeekScan({ commitments, ...extra }, ctx);

  it("keeps a good commitment whole and takes externalRef from the first linkable ref", () => {
    const out = scan([c({ goalId: "g1", taskId: "t1" })]);
    expect(out.commitments).toEqual([
      { text: "Ship the limiter", doneWhen: "PR merged", area: "delivery", kind: "deliver", goalId: "g1", taskId: "t1", externalRef: "ACME-12", refs: [{ kind: "ticket", label: "ACME-12", url: "ACME-12", date: null }] },
    ]);
  });
  it("drops bad refs: prose, http, javascript:, and a meeting outside the week or without a date", () => {
    const refs = [
      { kind: "ticket", label: "x", url: "see the board" },
      { kind: "doc", label: "x", url: "http://example.com/x" },
      { kind: "doc", label: "x", url: "javascript:alert(1)" },
      { kind: "meeting", label: "Early", date: "2026-11-08" },
      { kind: "meeting", label: "Late", date: "2026-11-16" },
      { kind: "meeting", label: "Nodate" },
      { kind: "meeting", label: "Design review", date: "2026-11-11", url: "http://not-https" },
      { kind: "pr", label: "A PR", url: "https://github.com/acme/api/pull/4" },
      { kind: "bogus", label: "x", url: "ACME-1" },
    ];
    expect(validateRefs(refs, WEEK)).toEqual([
      { kind: "meeting", label: "Design review", url: null, date: "2026-11-11" },
      { kind: "pr", label: "A PR", url: "https://github.com/acme/api/pull/4", date: null },
    ]);
    expect(validateRefs("nope", WEEK)).toEqual([]);
  });
  it("caps refs at 4", () => {
    const refs = Array.from({ length: 8 }, (_, i) => ({ kind: "ticket", label: `T${i}`, url: `ACME-${i + 1}` }));
    expect(validateRefs(refs, WEEK)).toHaveLength(4);
  });
  it("nulls unknown goal and task ids, and an area outside the framework", () => {
    const out = scan([c({ goalId: "nope", taskId: "nope2", area: "not_an_area" })]).commitments[0]!;
    expect([out.goalId, out.taskId, out.area]).toEqual([null, null, null]);
  });
  it("a known task fills in its goal; a task that belongs to another goal is nulled", () => {
    expect(scan([c({ taskId: "t1" })]).commitments[0]).toMatchObject({ goalId: "g1", taskId: "t1" });
    expect(scan([c({ goalId: "g2", taskId: "t1" })]).commitments[0]).toMatchObject({ goalId: "g2", taskId: null });
  });
  it("drops a commitment with no text or no doneWhen, and duplicates by text or ref", () => {
    const out = scan([
      c(), c({ text: "  ship THE limiter ", refs: [] }), c({ text: "Other words" }),
      c({ text: "No mark", doneWhen: "" }), c({ text: "", doneWhen: "x" }), "junk", null, c({ text: "Fine", refs: [] }),
    ]);
    expect(out.commitments.map((x) => x.text)).toEqual(["Ship the limiter", "Fine"]);
  });
  it("accepts a bare array and the legacy intentions key", () => {
    expect(validateWeekScan([c()], ctx).commitments).toHaveLength(1);
    expect(validateWeekScan({ intentions: [c()] }, ctx).commitments).toHaveLength(1);
  });
  it("caps lengths and counts: text 200, doneWhen 200, five commitments", () => {
    const long = scan([c({ text: "x".repeat(500), doneWhen: "y".repeat(500), refs: [] })]).commitments[0]!;
    expect(long.text.length).toBeLessThanOrEqual(200);
    expect(long.doneWhen.length).toBeLessThanOrEqual(200);
    const many = Array.from({ length: 9 }, (_, i) => c({ text: `Item ${i}`, refs: [{ kind: "ticket", label: "t", url: `ACME-${i + 1}` }] }));
    expect(scan(many).commitments).toHaveLength(5);
    const intent = scan([c()], { intent: { headline: "h".repeat(300), why: "w".repeat(900), focusGoalIds: ["g1", "g2", "g1", "zz"] } }).intent!;
    expect(intent.headline.length).toBeLessThanOrEqual(140);
    expect(intent.why.length).toBeLessThanOrEqual(400);
    expect(intent.focusGoalIds).toEqual(["g1", "g2"]);
    expect(scan([c()], { intent: { headline: "H", focusGoalIds: ["g1", "g2", "g1"] } }).intent!.focusGoalIds).toEqual(["g1", "g2"]);
  });
  it("throws when no commitment is usable or the commitments array is missing", () => {
    expect(() => scan([])).toThrow(/usable commitment/);
    expect(() => scan([c({ doneWhen: "" })])).toThrow(/usable commitment/);
    expect(() => validateWeekScan({ plan: [] }, ctx)).toThrow(/commitments/);
    expect(() => validateWeekScan("text", ctx)).toThrow();
  });
  it("shape: drops key meetings outside the week and caps at 5; a partial shape becomes null", () => {
    const km = (date: string, title = "Review") => ({ title, date, why: "prep" });
    const shape = scan([c()], { shape: { meetingHours: 11.55, meetingCount: 9.4, focusHours: 28, keyMeetings: [km("2026-11-10"), km("2026-11-20"), ...Array.from({ length: 8 }, (_, i) => km("2026-11-12", `M${i}`))] } }).shape!;
    expect(shape).toMatchObject({ meetingHours: 11.6, meetingCount: 9, focusHours: 28 });
    expect(shape.keyMeetings).toHaveLength(5);
    expect(shape.keyMeetings.every((m) => m.date >= "2026-11-09" && m.date <= "2026-11-15")).toBe(true);
    expect(scan([c()], { shape: { meetingHours: 1 } }).shape).toBeNull();
    expect(scan([c()], { shape: { meetingHours: -1, meetingCount: 1, focusHours: 1 } }).shape).toBeNull();
  });
  it("backlog: caps deferred at 5, drops blanks; a bad backlog and a missing intent are null", () => {
    const deferred = [{ label: "", why: "x" }, ...Array.from({ length: 8 }, (_, i) => ({ label: `L${i}`, why: "later" }))];
    expect(scan([c()], { backlog: { considered: 14, deferred } }).backlog!.deferred).toHaveLength(5);
    const out = scan([c()], { backlog: { considered: "many" } });
    expect([out.backlog, out.intent, out.shape]).toEqual([null, null, null]);
  });
  it("isRef accepts https URLs and issue keys only", () => {
    expect([isRef("ACME-12"), isRef("https://x.test/a"), isRef("http://x.test/a"), isRef("javascript:alert(1)"), isRef(12), isRef("")]).toEqual([true, true, false, false, false, false]);
  });
});

describe("validateRetro", () => {
  const ids = new Set(["J1109-1", "G1110-1"]);
  it("drops unknown evidence ids, blank derailers and duplicates, and caps at 4", () => {
    const out = validateRetro({ planRetro: { summary: "  Two   sentences. ", derailers: [{ text: "Incident", evidenceIds: ["J1109-1", "nope", "J1109-1"] }, { text: "  " }, "junk", ...Array.from({ length: 6 }, (_, i) => ({ text: `D${i}`, evidenceIds: [] }))] } }, ids)!;
    expect(out.summary).toBe("Two sentences.");
    expect(out.derailers).toHaveLength(4);
    expect(out.derailers[0]).toEqual({ text: "Incident", evidenceIds: ["J1109-1"] });
  });
  it("clips long text", () => {
    const out = validateRetro({ planRetro: { summary: "s".repeat(900), derailers: [{ text: "d".repeat(900), evidenceIds: [] }] } }, ids)!;
    expect(out.summary.length).toBeLessThanOrEqual(400);
    expect(out.derailers[0]!.text.length).toBeLessThanOrEqual(200);
  });
  it("is null when missing, malformed or empty, and never throws", () => {
    expect(validateRetro({}, ids)).toBeNull();
    expect(validateRetro({ planRetro: "x" }, ids)).toBeNull();
    expect(validateRetro({ planRetro: { summary: " ", derailers: [] } }, ids)).toBeNull();
    expect(validateRetro({ planRetro: { derailers: "x" } }, ids)).toBeNull();
    expect(validateRetro({ planRetro: { summary: "ok" } }, ids)).toEqual({ summary: "ok", derailers: [] });
  });
});

describe("unplannedShare", () => {
  const ev = (id: string, kind = "pull_request") => ({ id, kind });
  it("is uncited substantive evidence over all substantive evidence, rounded to 2 places", () => {
    expect(unplannedShare([ev("a"), ev("b"), ev("c")], [{ evidenceIds: ["a"] }])).toBe(0.67);
    expect(unplannedShare([ev("a"), ev("b")], [{ evidenceIds: ["a", "b", "zzz"] }])).toBe(0);
    expect(unplannedShare([ev("a"), ev("b")], [])).toBe(1);
  });
  it("ignores low-signal kinds and is null when nothing substantive exists", () => {
    const low = LOW_SIGNAL_KINDS[0]!;
    expect(unplannedShare([ev("a"), ev("l", low)], [])).toBe(1);
    expect(unplannedShare([ev("l", low)], [])).toBeNull();
    expect(unplannedShare([], [])).toBeNull();
  });
});

describe("planAccuracy", () => {
  const judged = (week: string, n: number, statuses: PlanResult["status"][]) => {
    const items = Array.from({ length: n }, (_, i) => item(`${week}-${i}`, { week }));
    return plan(week, items, statuses.map((st, i) => res(`${week}-${i}`, st, st === "done" ? ["x"] : [])));
  };
  it("builds the per-week trend oldest first, excluding dropped from committed, and pools the overall rate", () => {
    const out = planAccuracy([judged("2026-W45", 4, ["done", "partial", "not_done", "dropped"]), judged("2026-W44", 2, ["done", "done"]), plan("2026-W46", [item("u")]), emptyPlan("2026-W43")]);
    expect(out.byWeek).toEqual([
      { week: "2026-W44", hitRate: 1, committed: 2, hit: 2 },
      { week: "2026-W45", hitRate: 0.5, committed: 3, hit: 1 },
    ]);
    expect(out.overall).toBeCloseTo((2 + 1.5) / 5);
    expect(out.note).toContain("2 weeks");
  });
  it("is empty and says so with no judged weeks", () => {
    const out = planAccuracy([plan("2026-W46", [item("a")]), emptyPlan("2026-W45")]);
    expect(out).toMatchObject({ byWeek: [], overall: null });
    expect(out.note).toMatch(/No judged weeks/);
  });
});

describe("calibrationNote", () => {
  const w = (hitRate: number, committed: number) => ({ week: "2026-W45", hitRate, committed, hit: 0 });
  it("tells an over-committing planner to commit to fewer", () => {
    expect(calibrationNote([w(0.4, 5), w(0.5, 5)], 0.45)).toBe("Plans hit 45% over 2 weeks; it's been over-committing, so expect 3 commitments, not 5.");
  });
  it("asks for smaller marks when already at few commitments and still missing", () => {
    expect(calibrationNote([w(0.3, 2)], 0.3)).toMatch(/1 week; the marks are being missed even at 2 commitments/);
  });
  it("middle band is about right; a high rate leaves room for a stretch", () => {
    expect(calibrationNote([w(0.7, 4)], 0.7)).toBe("Plans hit 70% over 1 week; about right, so expect around 4 commitments with tight marks.");
    expect(calibrationNote([w(0.9, 4)], 0.9)).toMatch(/reliable.*stretch/);
  });
  it("handles no judged weeks", () => {
    expect(calibrationNote([{ week: "2026-W45", hitRate: null, committed: 3, hit: 0 }], null)).toMatch(/No judged weeks/);
  });
});

describe("old stored plans", () => {
  it("a plan saved before the week scan still parses with defaults filled in", () => {
    const old = { week: "2026-W44", items: [{ id: "a", week: "2026-W44", text: "Old item", area: null, source: "manual", externalRef: null, carriedFrom: null, carryCount: 1, createdAt: "x" }], results: [{ itemId: "a", status: "done", note: "", evidenceIds: ["J1"] }], hitRate: 1, judgedAt: "x" };
    const parsed = weekPlanSchema.parse(old);
    expect(parsed.items[0]).toMatchObject({ goalId: null, taskId: null, kind: "other", doneWhen: "", refs: [] });
    expect(parsed).toMatchObject({ intent: null, shape: null, backlog: null, retro: null, unplannedShare: null, plannedAt: null, plannedFor: null });
    expect(planRules(parsed.items)).not.toContain("| DONE WHEN");
  });
  it("an even older item with no carryCount or results also parses", () => {
    const parsed = weekPlanSchema.parse({ week: "2026-W40", items: [{ id: "a", week: "2026-W40", text: "x", area: null, source: "note", externalRef: null, carriedFrom: null, createdAt: "x" }], hitRate: null, judgedAt: null });
    expect(parsed.items[0]!.carryCount).toBe(0);
    expect(parsed.results).toEqual([]);
  });
});

const prop = (over: Partial<Proposal>): Proposal => ({ text: "x", area: null, kind: "other", doneWhen: "x", goalId: null, taskId: null, refs: [], externalRef: null, ...over });

describe("inferredItems", () => {
  it("marks items inferred and links a matching unfinished item of last week as a carry-over", () => {
    const prev = plan("2026-W45", [item("a", { week: "2026-W45", text: "Ship the limiter", carryCount: 1 }), item("b", { week: "2026-W45", text: "Done thing" })], [res("a", "not_done"), res("b", "done", ["x"])]);
    let k = 0;
    const out = inferredItems(
      "2026-W46",
      [prop({ text: "ship the LIMITER", externalRef: "ACME-12" }), prop({ text: "Fresh", area: "delivery", externalRef: "ACME-13", goalId: "g1", kind: "deliver", doneWhen: "Merged", refs: [{ kind: "pr", label: "PR", url: "https://x.test/1", date: null }] })],
      prev, NOW, () => `n${++k}`,
    );
    expect(out.map((o) => o.source)).toEqual(["inferred", "inferred"]);
    expect(out[0]).toMatchObject({ id: "n1", carriedFrom: "a", carryCount: 2, externalRef: "ACME-12" });
    expect(out[1]).toMatchObject({ carriedFrom: null, carryCount: 0, goalId: "g1", taskId: null, kind: "deliver", doneWhen: "Merged" });
    expect(out[1]!.refs).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "other", doneWhen: "x", refs: [] });
  });
});

describe("an inferred item on edit", () => {
  const inferred = item("a", { source: "inferred", text: "Ship the limiter", area: "delivery", externalRef: "ACME-12" });
  it("flips to manual when the text or area changes", () => {
    expect(buildItems("2026-W46", [{ id: "a", text: "Ship the limiter v2" }], [inferred], null, NOW, seq)[0]).toMatchObject({ id: "a", source: "manual", externalRef: "ACME-12" });
    expect(buildItems("2026-W46", [{ id: "a", text: "Ship the limiter", area: "mentorship" }], [inferred], null, NOW, seq)[0]!.source).toBe("manual");
    expect(buildItems("2026-W46", [{ id: "a", text: "Ship the limiter", area: null }], [inferred], null, NOW, seq)[0]!.source).toBe("manual");
  });
  it("stays inferred when saved unchanged, including an omitted area", () => {
    expect(buildItems("2026-W46", [{ id: "a", text: "Ship the limiter", area: "delivery" }], [inferred], null, NOW, seq)[0]!.source).toBe("inferred");
    expect(buildItems("2026-W46", [{ id: "a", text: "  Ship   the limiter " }], [inferred], null, NOW, seq)[0]!.source).toBe("inferred");
  });
  it("plan.set through the handler records the flip", async () => {
    const h = harness();
    const api = planHandlers(h.ctx, {} as never, {} as never);
    await h.store.set(KIND.plan, "2026-W46", plan("2026-W46", [inferred]));
    const got = await api["plan.set"]({ week: "2026-W46", items: [{ id: "a", text: "Something else" }] });
    expect(got.items[0]).toMatchObject({ id: "a", source: "manual", text: "Something else" });
  });
});

describe("validateGoalProgress", () => {
  const ctx = { goalIds: new Set(["g1", "g2"]), evidenceIds: new Set(["J1109-1", "G1110-1"]) };
  it("keeps known goals, drops unknown goal and evidence ids, and keeps the first of a repeat", () => {
    const out = validateGoalProgress(
      { goalProgress: [{ goalId: "g1", status: "advanced", evidenceIds: ["J1109-1", "nope", "J1109-1"] }, { goalId: "g1", status: "no_movement", evidenceIds: [] }, { goalId: "zz", status: "advanced", evidenceIds: ["J1109-1"] }] },
      ctx,
    );
    expect(out).toEqual([{ goalId: "g1", status: "advanced", evidenceIds: ["J1109-1"] }]);
  });
  it("turns advanced without usable evidence into no_movement, and ignores bad statuses", () => {
    const out = validateGoalProgress(
      { goalProgress: [{ goalId: "g1", status: "advanced", evidenceIds: ["nope"] }, { goalId: "g2", status: "great", evidenceIds: ["J1109-1"] }, "junk", null] },
      ctx,
    );
    expect(out).toEqual([{ goalId: "g1", status: "no_movement", evidenceIds: [] }]);
  });
  it("is empty without a goalProgress array", () => {
    expect(validateGoalProgress({}, ctx)).toEqual([]);
    expect(validateGoalProgress({ goalProgress: "x" }, ctx)).toEqual([]);
  });
});
