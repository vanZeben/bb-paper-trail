import { describe, expect, it } from "vitest";
import { previousWeeks, weekDates } from "../lib/engine/dates";
import { createRegistry, runGridContributors, runWeekHooks, type FeatureCtx } from "../lib/engine/extensions";
import { DEFAULT_FRAMEWORK } from "../lib/framework/default";
import { register } from "../lib/features/guardrails";
import { currentResults } from "../lib/features/guardrails/lifecycle";
import { NOT_CAPTURED } from "../lib/types";
import { defaultRules, evaluateRule, evaluateRules, type RuleContext, type WeekFacts } from "../lib/features/guardrails/rules";
import { acknowledgeResult, evaluateWeek, loadRules } from "../lib/features/guardrails/service";
import { weekPlan } from "./fixtures";
import { handlers } from "../lib/handlers/guardrails";
import { DEFAULT_SETTINGS } from "../lib/settings";
import { createMemoryStore } from "../lib/storage/memory";
import { KIND } from "../lib/storage/port";
import {
  gridV2Schema, workWeekSchema, type CovStatus, type DriftSnapshot, type GuardrailRule, type Thread, type WeekMix, type WeekPlan, type WorkWeek,
} from "../lib/types";

const W = "2026-W46";
const NOW = new Date("2026-11-13T22:00:00Z");
const weeksEnding = (week: string, n: number) => [...previousWeeks(week, n - 1), week];

const weekRec = (id: string, over: Record<string, unknown> = {}): WorkWeek =>
  workWeekSchema.parse({
    version: 2, week: id, from: weekDates(id)[0], to: weekDates(id)[4], generatedAt: "2026-11-13T00:00:00Z", model: null, final: true, rating: "meets", ratingReason: "r",
    threeLines: [], days: [], daysWorked: 5, scorecard: [], meetings: { count: 0, hours: 0, pctOfWeek: 0, passiveCount: 0, topSinks: [] },
    reflection: { goodWeek: true, text: "" }, coverage: {}, ...over,
  });
const facts = (id: string, over: Partial<WeekFacts> = {}): WeekFacts => ({ week: id, record: null, mix: null, plan: null, coverageDays: [], ...over });
const ctxOf = (recs: Partial<WeekFacts>[] | Record<string, Partial<WeekFacts>>, over: Partial<RuleContext> = {}): RuleContext => {
  const map: Record<string, WeekFacts> = {};
  if (Array.isArray(recs)) weeksEnding(W, recs.length).forEach((w, i) => (map[w] = facts(w, recs[i])));
  else for (const [w, f] of Object.entries(recs)) map[w] = facts(w, f);
  return {
    week: W, facts: map, snapshot: null, threads: null, closures: [], isLatest: true,
    areaLabels: Object.fromEntries(DEFAULT_FRAMEWORK.areas.map((a) => [a.key, a.label])), resolveArea: (k) => (DEFAULT_FRAMEWORK.areas.some((a) => a.key === k) ? k : null), ...over,
  };
};
const rule = (r: GuardrailRule["rule"], over: Partial<GuardrailRule> = {}): GuardrailRule => ({ id: "r1", enabled: true, severity: "warning", rule: r, ...over });
const outcome = (r: GuardrailRule, ctx: RuleContext) => evaluateRule(r, ctx).outcome;
const mix = (id: string, actual: Record<string, number>): WeekMix => ({ week: id, daysCounted: 5, actual, scorecard: {}, drift: null });
const pct = (p: number) => ({ record: weekRec(W, { meetings: { count: 5, hours: 10, pctOfWeek: p, passiveCount: 0, topSinks: [] } }) });
const missed = (area: string, status: "hit" | "partial" | "missed", ids: string[] = []) => ({ area, status, note: "", evidenceIds: ids });

describe("evaluateRules, one rule type at a time", () => {
  it("meeting_load fires strictly past maxPct", () => {
    const r = rule({ type: "meeting_load", maxPct: 60, weeks: 1 });
    expect(outcome(r, ctxOf({ [W]: pct(60) }))).toBe("ok");
    const hit = evaluateRule(r, ctxOf({ [W]: pct(61) }));
    expect(hit.outcome).toBe("breach");
    expect(hit.title).toContain("61%");
  });
  it("meeting_load averages over its weeks and skips weeks with no data", () => {
    const r = rule({ type: "meeting_load", maxPct: 50, weeks: 2 });
    const [a, b] = weeksEnding(W, 2) as [string, string];
    expect(outcome(r, ctxOf({ [a]: { record: weekRec(a, { meetings: { count: 1, hours: 1, pctOfWeek: 40, passiveCount: 0, topSinks: [] } }) }, [b]: pct(60) }))).toBe("ok"); // avg 50
    expect(outcome(r, ctxOf({ [a]: {}, [b]: pct(51) }))).toBe("breach"); // only the week with data counts
    expect(outcome(r, ctxOf({ [W]: {} }))).toBe("skip");
  });

  it("area_missed fires at N consecutive missed weeks, not N-1", () => {
    const r = rule({ type: "area_missed", area: "mentorship", weeks: 3 });
    const m = (s: "hit" | "missed") => ({ record: weekRec(W, { scorecard: [missed("mentorship", s)] }) });
    expect(outcome(r, ctxOf([m("missed"), m("missed")]))).toBe("ok");
    expect(outcome(r, ctxOf([m("missed"), m("missed"), m("missed")]))).toBe("breach");
  });
  it("area_missed needs the weeks to be consecutive", () => {
    const r = rule({ type: "area_missed", area: "mentorship", weeks: 3 });
    const rec = (s: "missed" | "partial") => ({ record: weekRec(W, { scorecard: [missed("mentorship", s)] }) });
    expect(outcome(r, ctxOf([rec("missed"), rec("partial"), rec("missed")]))).toBe("ok");
    expect(outcome(r, ctxOf([rec("missed"), {}, rec("missed")]))).toBe("ok"); // a week with no record breaks the run
    expect(outcome(r, ctxOf([rec("missed"), rec("missed"), rec("missed"), rec("partial")]))).toBe("ok"); // the run must reach this week
  });
  it("area_missed with area null names every area missed and carries the evidence", () => {
    const r = rule({ type: "area_missed", area: null, weeks: 2 });
    const ev = [{ id: "G1109-1", date: "2026-11-09", source: "github", kind: "pr", what: "PR", link: "https://x/1", outcome: null }];
    const rec = (ids: string[]) => ({ record: weekRec(W, { scorecard: [missed("direction", "missed", ids), missed("delivery", "hit")], evidence: ev }) });
    const res = evaluateRule(r, ctxOf([rec([]), rec(["G1109-1"])]));
    expect(res.outcome).toBe("breach");
    expect(res.title).toContain("Direction");
    expect(res.title).not.toContain("Delivery");
    expect(res.evidence).toEqual([{ date: "2026-11-09", id: "G1109-1", link: "https://x/1" }]);
  });

  it("area_absent fires when no listed area appears for N weeks, and never on missing data", () => {
    const r = rule({ type: "area_absent", areas: ["delivery"], weeks: 4 }, { severity: "info" });
    const none = { mix: mix(W, { delivery: 0, mentorship: 1 }) };
    const some = { mix: mix(W, { delivery: 0.2, mentorship: 0.8 }) };
    expect(outcome(r, ctxOf([some, none, none, none]))).toBe("ok");
    expect(outcome(r, ctxOf([none, none, none, none]))).toBe("breach");
    expect(outcome(r, ctxOf([{}, none, none, none]))).toBe("ok"); // unknown week is not evidence of absence
    expect(outcome(r, ctxOf([none, none, none]))).toBe("ok"); // the fourth week has no data at all
  });
  it("area_absent counts any of several listed areas", () => {
    const r = rule({ type: "area_absent", areas: ["delivery", "quality_reliability"], weeks: 1 });
    expect(outcome(r, ctxOf({ [W]: { mix: mix(W, { quality_reliability: 0.1, mentorship: 0.9 }) } }))).toBe("ok");
  });

  it("open_asks_age fires when an ask has been open N weeks running", () => {
    const r = rule({ type: "open_asks_age", weeks: 3 });
    const ask = (text: string, ids: string[] = []) => ({ record: weekRec(W, { openAsks: [{ text, evidenceIds: ids }] }) });
    expect(outcome(r, ctxOf([ask("Need review of the ADR"), ask("need review of the adr!")]))).toBe("ok"); // N-1
    const hit = evaluateRule(r, ctxOf([ask("Need review of the ADR"), ask("need review of the adr!"), ask("Need review of the ADR")]));
    expect(hit.outcome).toBe("breach");
    expect(hit.title).toContain("Need review of the ADR");
  });
  it("open_asks_age matches reworded asks by shared evidence, and breaks on a gap", () => {
    const r = rule({ type: "open_asks_age", weeks: 3 });
    const ask = (text: string, ids: string[]) => ({ record: weekRec(W, { openAsks: [{ text, evidenceIds: ids }] }) });
    expect(outcome(r, ctxOf([ask("Waiting on design sign-off", ["S1105-1"]), ask("Still waiting on sign-off", ["S1105-1"]), ask("Sign-off still pending", ["S1105-1"])]))).toBe("breach");
    expect(outcome(r, ctxOf([ask("A", []), { record: weekRec(W) }, ask("A", [])]))).toBe("ok");
    expect(outcome(r, ctxOf([{}, ask("A", []), ask("A", [])]))).toBe("ok");
  });

  it("coverage_failure fires at daysPerWeek failed days; off, ok and partial never count", () => {
    const r = rule({ type: "coverage_failure", source: null, daysPerWeek: 3 }, { severity: "info" });
    const d = (date: string, c: Record<string, CovStatus>) => ({ date, coverage: c });
    const two = [d("2026-11-09", { slack: "failed" }), d("2026-11-10", { slack: "failed" }), d("2026-11-11", { slack: "partial" })];
    expect(outcome(r, ctxOf({ [W]: { coverageDays: two } }))).toBe("ok");
    const three = [...two, d("2026-11-12", { slack: "failed" })];
    const hit = evaluateRule(r, ctxOf({ [W]: { coverageDays: three } }));
    expect(hit.outcome).toBe("breach");
    expect(hit.title).toContain("slack on 3 days");
  });
  it("coverage_failure ignores sources that are off", () => {
    const off = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"].map((date) => ({ date, coverage: { granola: "off" as const } }));
    expect(outcome(rule({ type: "coverage_failure", source: null, daysPerWeek: 1 }), ctxOf({ [W]: { coverageDays: off } }))).toBe("ok");
    expect(outcome(rule({ type: "coverage_failure", source: "granola", daysPerWeek: 1 }), ctxOf({ [W]: { coverageDays: off } }))).toBe("ok");
  });
  it("coverage_failure ignores NOT_CAPTURED days but still counts real failures", () => {
    const nc = ["2026-11-09", "2026-11-10", "2026-11-11"].map((date) => ({ date, coverage: { fellow: NOT_CAPTURED } }));
    expect(outcome(rule({ type: "coverage_failure", source: null, daysPerWeek: 1 }), ctxOf({ [W]: { coverageDays: nc } }))).toBe("ok");
    const real = ["2026-11-09", "2026-11-10", "2026-11-11"].map((date) => ({ date, coverage: { fellow: { status: "failed" as const, note: "timeout" } } }));
    expect(outcome(rule({ type: "coverage_failure", source: null, daysPerWeek: 3 }), ctxOf({ [W]: { coverageDays: real } }))).toBe("breach");
    const mixed = [...nc, ...real.slice(0, 2)];
    expect(outcome(rule({ type: "coverage_failure", source: null, daysPerWeek: 3 }), ctxOf({ [W]: { coverageDays: mixed } }))).toBe("ok");
  });
  it("coverage_failure can watch one source", () => {
    const days = ["2026-11-09", "2026-11-10"].map((date) => ({ date, coverage: { slack: "failed" as const, jira: "failed" as const } }));
    expect(outcome(rule({ type: "coverage_failure", source: "github", daysPerWeek: 2 }), ctxOf({ [W]: { coverageDays: days } }))).toBe("ok");
    expect(outcome(rule({ type: "coverage_failure", source: "jira", daysPerWeek: 2 }), ctxOf({ [W]: { coverageDays: days } }))).toBe("breach");
  });

  it("drift_over fires strictly past the score and is skipped without a snapshot", () => {
    const snap = (score: number): DriftSnapshot => ({ week: W, windowWeeks: 4, actual: {}, target: {}, perArea: { mentorship: -score }, score, status: "off", biggestOver: null, biggestUnder: "mentorship", computedAt: "t" });
    const r = rule({ type: "drift_over", score: 20 });
    expect(outcome(r, ctxOf({}, { snapshot: snap(20) }))).toBe("ok");
    const hit = evaluateRule(r, ctxOf({}, { snapshot: snap(20.1) }));
    expect(hit.outcome).toBe("breach");
    expect(hit.title).toContain("Mentorship is 20.1 points under target");
    expect(outcome(r, ctxOf({}))).toBe("skip");
  });

  it("plan_hit_below fires strictly below pct, averaging weeks that have a plan, and skips with none", () => {
    const r = rule({ type: "plan_hit_below", pct: 60, weeks: 2 });
    const plan = (hitRate: number | null): { plan: WeekPlan } => ({ plan: weekPlan({ week: W, hitRate }) });
    expect(outcome(r, ctxOf([plan(0.6), plan(0.6)]))).toBe("ok");
    expect(outcome(r, ctxOf([plan(0.59), plan(0.6)]))).toBe("breach"); // avg 59.5
    expect(outcome(r, ctxOf([{}, plan(0.5)]))).toBe("breach");
    expect(outcome(r, ctxOf([{}, {}]))).toBe("skip");
    expect(outcome(r, ctxOf([plan(null), plan(null)]))).toBe("skip");
  });

  it("area_share_min fires strictly below the minimum", () => {
    const r = rule({ type: "area_share_min", area: "mentorship", minPct: 10, weeks: 1 });
    expect(outcome(r, ctxOf({ [W]: { mix: mix(W, { mentorship: 0.1 }) } }))).toBe("ok");
    expect(outcome(r, ctxOf({ [W]: { mix: mix(W, { mentorship: 0.099 }) } }))).toBe("breach");
    expect(outcome(r, ctxOf({ [W]: {} }))).toBe("skip");
  });
  it("area_share_max fires strictly above the maximum, averaged over the window", () => {
    const r = rule({ type: "area_share_max", area: "delivery", maxPct: 50, weeks: 2 });
    const [a, b] = weeksEnding(W, 2) as [string, string];
    expect(outcome(r, ctxOf({ [a]: { mix: mix(a, { delivery: 0.4 }) }, [b]: { mix: mix(b, { delivery: 0.6 }) } }))).toBe("ok"); // 50
    expect(outcome(r, ctxOf({ [a]: { mix: mix(a, { delivery: 0.4 }) }, [b]: { mix: mix(b, { delivery: 0.62 }) } }))).toBe("breach"); // 51
  });

  const thread = (id: string, status: Thread["status"], over: Partial<Thread> = {}): Thread => ({
    id, title: `Thread ${id}`, keys: [], weeks: [], firstWeek: W, lastWeek: W, status, droppedReason: null, links: [], hidden: false, ...over,
  });
  it("wip_limit fires strictly past max active threads and is skipped without threads", () => {
    const r = rule({ type: "wip_limit", max: 2 }, { severity: "info" });
    const five = [thread("a", "active"), thread("b", "at_risk"), thread("c", "shipped"), thread("d", "stale"), thread("e", "active", { hidden: true })];
    expect(outcome(r, ctxOf({}, { threads: five }))).toBe("ok"); // 2 active (hidden and finished ones do not count)
    expect(evaluateRule(r, ctxOf({}, { threads: [...five, thread("f", "active")] })).title).toContain("3 threads");
    expect(outcome(r, ctxOf({}))).toBe("skip");
    expect(outcome(r, ctxOf({}, { threads: five, isLatest: false }))).toBe("skip");
  });
  it("closure_rate fires strictly below minPct of shipped threads with a closure note", () => {
    const r = rule({ type: "closure_rate", minPct: 50, weeks: 4 });
    const shipped = (id: string, over: Partial<Thread> = {}) => thread(id, "shipped", { weeks: [{ week: W, state: "shipped", text: "", evidenceIds: [] }], ...over });
    const note = (threadId: string) => ({ threadId, outcome: "better" as const, expectation: "", result: "", learnings: "", source: "user" as const, at: "t" });
    const threads = [shipped("a"), shipped("b")];
    expect(outcome(r, ctxOf({}, { threads, closures: [note("a")] }))).toBe("ok"); // 50%
    expect(evaluateRule(r, ctxOf({}, { threads, closures: [] })).title).toContain("0 of 2");
    expect(outcome(r, ctxOf({}, { threads: [] }))).toBe("ok"); // nothing shipped
    expect(outcome(r, ctxOf({}))).toBe("skip");
  });

  it("evaluateRules skips disabled rules", () => {
    const rules = [rule({ type: "meeting_load", maxPct: 10, weeks: 1 }, { enabled: false }), rule({ type: "meeting_load", maxPct: 10, weeks: 1 }, { id: "r2" })];
    expect(evaluateRules(rules, ctxOf({ [W]: pct(90) })).map((e) => e.ruleId)).toEqual(["r2"]);
  });
});

describe("defaults", () => {
  it("are the six agreed rules, and every one parses", async () => {
    const rules = defaultRules(["delivery"]);
    expect(rules.map((r) => [r.id, r.severity, r.rule.type])).toEqual([
      ["meeting_load", "warning", "meeting_load"],
      ["area_missed", "warning", "area_missed"],
      ["no_hands_on", "info", "area_absent"],
      ["open_asks", "warning", "open_asks_age"],
      ["source_failing", "info", "coverage_failure"],
      ["too_many_threads", "info", "wip_limit"],
    ]);
    expect(rules[0]!.rule).toEqual({ type: "meeting_load", maxPct: 60, weeks: 1 });
    expect(rules[1]!.rule).toEqual({ type: "area_missed", area: null, weeks: 3 });
    expect(rules[2]!.rule).toEqual({ type: "area_absent", areas: ["delivery"], weeks: 4 });
    expect(rules[3]!.rule).toEqual({ type: "open_asks_age", weeks: 3 });
    expect(rules[4]!.rule).toEqual({ type: "coverage_failure", source: null, daysPerWeek: 3 });
    expect(rules[5]!.rule).toEqual({ type: "wip_limit", max: 5 });
  });
  it("omit the hands-on rule when the framework has no hands-on area", () => {
    expect(defaultRules([]).some((r) => r.rule.type === "area_absent")).toBe(false);
  });
});

function harness() {
  const store = createMemoryStore();
  const clock = { now: NOW };
  const ctx: FeatureCtx = {
    store, settings: () => ({ ...DEFAULT_SETTINGS, timeZone: "America/New_York" }), framework: async () => DEFAULT_FRAMEWORK,
    runner: { status: () => ({ running: 0, queued: 0 }), runJob: (() => { throw new Error("no jobs"); }) as never },
    log: { info: () => undefined, warn: () => undefined }, publish: () => undefined, now: () => clock.now,
  };
  const reg = createRegistry();
  register(reg);
  return { store, ctx, reg, clock };
}
const saveWeek = (store: ReturnType<typeof harness>["store"], id: string, over: Record<string, unknown> = {}) => {
  const rec = weekRec(id, over);
  return store.set(KIND.week, id, rec).then(() => rec);
};
const loud = { meetings: { count: 9, hours: 25, pctOfWeek: 80, passiveCount: 0, topSinks: [] } };
const calm = { meetings: { count: 2, hours: 4, pctOfWeek: 20, passiveCount: 0, topSinks: [] } };
const open = async (store: ReturnType<typeof harness>["store"]) =>
  (await store.list(KIND.violation, (await import("../lib/types")).guardrailResultSchema)).map((r) => r.value);

describe("hook lifecycle", () => {
  it("writes the default rules on first read and keeps them", async () => {
    const { store, ctx } = harness();
    const rules = await loadRules(ctx);
    expect(rules).toHaveLength(6);
    expect(rules.find((r) => r.id === "no_hands_on")!.rule).toMatchObject({ areas: ["delivery"] });
    expect((await store.list(KIND.rules, (await import("zod")).z.array((await import("../lib/types")).guardrailRuleSchema))).length).toBe(1);
    await store.set(KIND.rules, "active", [rules[0]!]);
    expect(await loadRules(ctx)).toHaveLength(1);
  });

  it("writes a violation record `${ruleId}:${week}` when a rule breaches", async () => {
    const { store, ctx, reg } = harness();
    await runWeekHooks(reg, await saveWeek(store, W, loud), ctx);
    const results = await open(store);
    expect(results.map((r) => r.id)).toEqual([`meeting_load:${W}`]);
    expect(results[0]).toMatchObject({ ruleId: "meeting_load", week: W, severity: "warning", state: "open", firstBreachedWeek: W, ackNote: null });
    expect(results[0]!.title).toContain("80%");
  });

  it("resolves the open result when the rule stops breaching", async () => {
    const { store, ctx, reg } = harness();
    await runWeekHooks(reg, await saveWeek(store, W, loud), ctx);
    await runWeekHooks(reg, await saveWeek(store, W, calm), ctx);
    expect((await open(store))[0]!.state).toBe("resolved");
  });

  it("resolves earlier weeks' results on recovery, and carries firstBreachedWeek through a streak", async () => {
    const { store, ctx, reg } = harness();
    const [w45] = previousWeeks(W, 1) as [string];
    await runWeekHooks(reg, await saveWeek(store, w45, loud), ctx);
    await runWeekHooks(reg, await saveWeek(store, W, loud), ctx);
    const streak = (await open(store)).find((r) => r.id === `meeting_load:${W}`)!;
    expect(streak.firstBreachedWeek).toBe(w45);
    await runWeekHooks(reg, await saveWeek(store, W, calm), ctx);
    expect((await open(store)).map((r) => r.state)).toEqual(["resolved", "resolved"]);
  });

  it("an acknowledgement survives re-evaluation and carries to the next week of the streak", async () => {
    const { store, ctx, reg } = harness();
    const [w45] = previousWeeks(W, 1) as [string];
    await runWeekHooks(reg, await saveWeek(store, w45, loud), ctx);
    await acknowledgeResult(ctx, `meeting_load:${w45}`, "known, release crunch");
    await runWeekHooks(reg, await saveWeek(store, w45, loud), ctx); // re-evaluate the same week
    let results = await open(store);
    expect(results[0]).toMatchObject({ state: "acknowledged", ackNote: "known, release crunch" });
    await runWeekHooks(reg, await saveWeek(store, W, loud), ctx); // next week of the streak
    results = await open(store);
    expect(results.find((r) => r.week === W)).toMatchObject({ state: "acknowledged", ackNote: "known, release crunch", firstBreachedWeek: w45 });
    expect(currentResults(results)).toEqual([]); // nothing left open for the banner
  });

  it("a breach that returns after being resolved reopens", async () => {
    const { store, ctx, reg } = harness();
    await runWeekHooks(reg, await saveWeek(store, W, loud), ctx);
    await runWeekHooks(reg, await saveWeek(store, W, calm), ctx);
    await runWeekHooks(reg, await saveWeek(store, W, loud), ctx);
    expect((await open(store))[0]).toMatchObject({ state: "open", ackNote: null });
  });

  it("skipped rules leave results alone, and removed rules resolve theirs", async () => {
    const { store, ctx, reg } = harness();
    await runWeekHooks(reg, await saveWeek(store, W, loud), ctx);
    await store.set(KIND.rules, "active", [rule({ type: "plan_hit_below", pct: 50, weeks: 1 }, { id: "plan" })]); // no plan data: skipped
    await evaluateWeek(ctx, W);
    expect((await open(store)).find((r) => r.ruleId === "meeting_load")!.state).toBe("resolved"); // its rule is gone
    expect((await open(store)).find((r) => r.ruleId === "plan")).toBeUndefined();
  });

  it("area_missed through the store: N consecutive weeks write one result with evidence", async () => {
    const { store, ctx, reg } = harness();
    const ev = [{ id: "J1109-1", date: "2026-11-09", source: "jira", kind: "x", what: "t", link: "https://j/1", outcome: null }];
    const [w44, w45] = previousWeeks(W, 2) as [string, string];
    for (const w of [w44, w45]) await saveWeek(store, w, { scorecard: [missed("mentorship", "missed")] });
    const rec = await saveWeek(store, W, { scorecard: [missed("mentorship", "missed", ["J1109-1"])], evidence: ev });
    await runWeekHooks(reg, rec, ctx);
    const res = (await open(store)).find((r) => r.ruleId === "area_missed")!;
    expect(res.title).toBe("Mentorship missed 3 weeks in a row");
    expect(res.evidence).toEqual([{ date: "2026-11-09", id: "J1109-1", link: "https://j/1" }]);
  });

  it("reads threads and closures from their records when they exist", async () => {
    const { store, ctx, reg } = harness();
    const t = (id: string): Thread => ({ id, title: id, keys: [], weeks: [], firstWeek: W, lastWeek: W, status: "active", droppedReason: null, links: [], hidden: false });
    await runWeekHooks(reg, await saveWeek(store, W, calm), ctx);
    expect(await open(store)).toEqual([]); // no threads record: wip_limit skipped quietly
    await store.set(KIND.threads, "derived", ["a", "b", "c", "d", "e", "f"].map(t));
    await runWeekHooks(reg, await saveWeek(store, W, calm), ctx);
    expect((await open(store)).map((r) => r.ruleId)).toEqual(["too_many_threads"]);
  });

  it("reads the threads feature's object-shaped record", async () => {
    const { store, ctx, reg } = harness();
    const t = (id: string): Thread => ({ id, title: id, keys: [], weeks: [], firstWeek: W, lastWeek: W, status: "active", droppedReason: null, links: [], hidden: false });
    await store.set(KIND.threads, "derived", { builtAt: "2026-11-16T00:00:00Z", todayWeek: W, threads: ["a", "b", "c", "d", "e", "f"].map(t), needClosure: [] });
    await runWeekHooks(reg, await saveWeek(store, W, calm), ctx);
    expect((await open(store)).map((r) => r.ruleId)).toEqual(["too_many_threads"]);
  });

  it("sets markers.guardrail (worst open severity) and guardrailCount", async () => {
    const { store, ctx, reg } = harness();
    const [w45] = previousWeeks(W, 1) as [string];
    await store.set(KIND.rules, "active", [
      rule({ type: "meeting_load", maxPct: 10, weeks: 1 }, { id: "m", severity: "warning" }),
      rule({ type: "meeting_load", maxPct: 15, weeks: 1 }, { id: "n", severity: "breach" }),
      rule({ type: "meeting_load", maxPct: 18, weeks: 1 }, { id: "o", severity: "info" }),
    ]);
    await runWeekHooks(reg, await saveWeek(store, W, loud), ctx);
    await runWeekHooks(reg, await saveWeek(store, w45, calm), ctx); // 20% > 10, 15, 18
    const mk = (w: string) => ({ week: w, from: weekDates(w)[0]!, label: w, monthLabel: null, rating: null, final: true, cells: [] });
    const grid = gridV2Schema.parse({
      today: "2026-11-13", currentWeek: W, weeks: [mk(previousWeeks(W, 2)[0]!), mk(w45), mk(W)], status: { running: null, queued: [], lastError: null },
      areas: [], lensAvailability: { rating: true, area: true, meeting: true, evidence: true, plan: false }, timeZone: "America/New_York", workdayHours: 7.5,
    });
    await runGridContributors(reg, grid, ctx);
    expect(grid.weeks.map((w) => [w.markers.guardrail, w.markers.guardrailCount])).toEqual([[null, 0], ["breach", 3], ["breach", 3]]);
    await acknowledgeResult(ctx, `n:${W}`, "ok");
    const grid2 = structuredClone(grid);
    for (const w of grid2.weeks) w.markers = { ...w.markers, guardrail: null, guardrailCount: 0 };
    await runGridContributors(reg, grid2, ctx);
    expect(grid2.weeks.at(-1)!.markers.guardrail).toBe("warning");
  });
});

describe("handlers", () => {
  it("rules.get/set round-trip, validate ids, and results filter by state; ack resolves through the banner view", async () => {
    const { store, ctx, reg } = harness();
    const h = handlers(ctx, null as never, null as never);
    expect((await h["guardrails.rules.get"](null)).rules).toHaveLength(6);
    await expect(h["guardrails.rules.set"]({ rules: [rule({ type: "wip_limit", max: 3 }, { id: "a:b" })] })).rejects.toThrow(/Rule id/);
    await expect(h["guardrails.rules.set"]({ rules: [rule({ type: "wip_limit", max: 3 }), rule({ type: "wip_limit", max: 4 })] })).rejects.toThrow(/Duplicate/);
    await runWeekHooks(reg, await saveWeek(store, W, loud), ctx);
    expect((await h["guardrails.results"]({ weeks: 12, state: "open" })).results).toHaveLength(1);
    expect((await h["guardrails.results"]({ weeks: 12, state: "resolved" })).results).toHaveLength(0);
    await h["guardrails.ack"]({ id: `meeting_load:${W}`, note: "seen" });
    expect((await h["guardrails.results"]({ weeks: 12, state: "acknowledged" })).results[0]!.ackNote).toBe("seen");
    await expect(h["guardrails.ack"]({ id: "nope:2026-W01", note: "x" })).rejects.toThrow();
    // changing the rules re-evaluates the recent weeks: raising the limit resolves the breach
    await h["guardrails.rules.set"]({ rules: [rule({ type: "meeting_load", maxPct: 95, weeks: 1 }, { id: "meeting_load" })] });
    expect((await open(store))[0]!.state).toBe("resolved");
  });
});
