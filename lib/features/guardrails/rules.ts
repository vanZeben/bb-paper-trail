/**
 * rules.ts — pure rule evaluation. No store, no clock; everything a rule needs arrives in a RuleContext.
 *
 * Thresholds: count rules (area_missed, area_absent, open_asks_age, coverage_failure) fire AT the number
 * ("3 weeks" fires on the third); percentage rules (meeting_load, area_share_*, plan_hit_below, closure_rate,
 * drift_over) and wip_limit fire strictly past it. Missing data never fires a rule.
 * Type-only imports from types.ts, so this file is safe to import anywhere.
 */
import { previousWeeks } from "../../engine/dates";
import { NOT_CAPTURED } from "../../types";
import type { ClosureNote, Coverage, CovStatus, DriftSnapshot, EvidenceRef, GuardrailRule, Thread, WeekMix, WeekPlan, WorkWeek } from "../../types";

export interface WeekFacts {
  week: string;
  record: WorkWeek | null;
  mix: WeekMix | null;
  plan: WeekPlan | null;
  /** Per-day source coverage for the days of this week (only the evaluated week needs it). */
  coverageDays: Array<{ date: string; coverage: Record<string, CovStatus | Coverage> }>;
}

export interface RuleContext {
  /** The week being evaluated: the newest week in every window. */
  week: string;
  facts: Record<string, WeekFacts>;
  snapshot: DriftSnapshot | null;
  /** The `threads` record; null when the threads feature has produced nothing (thread rules are then skipped). */
  threads: Thread[] | null;
  closures: ClosureNote[];
  /** No later week exists: point-in-time rules (wip_limit, closure_rate) only apply here. */
  isLatest: boolean;
  areaLabels: Record<string, string>;
  resolveArea: (key: string) => string | null;
}

export type Outcome = "breach" | "ok" | "skip";
export interface Evaluation {
  ruleId: string;
  severity: GuardrailRule["severity"];
  outcome: Outcome;
  title: string;
  detail: string;
  evidence: EvidenceRef[];
}

const MAX_EVIDENCE = 8;
const ok = (rule: GuardrailRule): Evaluation => ({ ruleId: rule.id, severity: rule.severity, outcome: "ok", title: "", detail: "", evidence: [] });
const skip = (rule: GuardrailRule): Evaluation => ({ ...ok(rule), outcome: "skip" });
const breach = (rule: GuardrailRule, title: string, detail: string, evidence: EvidenceRef[] = []): Evaluation => ({
  ruleId: rule.id,
  severity: rule.severity,
  outcome: "breach",
  title,
  detail,
  evidence: dedupeEvidence(evidence).slice(0, MAX_EVIDENCE),
});

const round1 = (n: number): number => Math.round(n * 10) / 10;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const dedupeEvidence = (refs: EvidenceRef[]): EvidenceRef[] => {
  const seen = new Set<string>();
  return refs.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
};

/** The `n` weeks ending at ctx.week, oldest first. */
export const windowWeeks = (ctx: RuleContext, n: number): string[] => [...previousWeeks(ctx.week, Math.max(1, n) - 1), ctx.week];
const label = (ctx: RuleContext, key: string): string => ctx.areaLabels[key] ?? key;

function refsFor(record: WorkWeek | null, ids: readonly string[]): EvidenceRef[] {
  if (record === null) return [];
  const byId = new Map(record.evidence.map((e) => [e.id, e]));
  const out: EvidenceRef[] = [];
  for (const id of ids) {
    const e = byId.get(id);
    if (e !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(e.date)) out.push({ date: e.date, id: e.id, link: e.link });
  }
  return out;
}

const avg = (values: number[]): number => values.reduce((s, v) => s + v, 0) / values.length;

/** Plan hit rates are 0..1 in the plan record; a value above 1 is taken as already a percentage. */
const asPct = (hitRate: number): number => (hitRate > 1 ? hitRate : hitRate * 100);

const normalise = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

type Of<T extends GuardrailRule["rule"]["type"]> = Extract<GuardrailRule["rule"], { type: T }>;

function meetingLoad(rule: GuardrailRule, r: Of<"meeting_load">, ctx: RuleContext): Evaluation {
  const weeks = windowWeeks(ctx, r.weeks).filter((w) => {
    const rec = ctx.facts[w]?.record;
    return rec != null && rec.daysWorked > 0;
  });
  if (weeks.length === 0) return skip(rule);
  const pct = round1(avg(weeks.map((w) => ctx.facts[w]!.record!.meetings.pctOfWeek)));
  if (!(pct > r.maxPct)) return ok(rule);
  const span = r.weeks === 1 ? "the week" : `the last ${r.weeks} weeks`;
  return breach(rule, `Meetings took ${pct}% of ${span}`, `Over the ${r.maxPct}% limit (${pct}% of working time across ${plural(weeks.length, "week")} with data).`);
}

function areaMissed(rule: GuardrailRule, r: Of<"area_missed">, ctx: RuleContext): Evaluation {
  const weeks = windowWeeks(ctx, r.weeks);
  const missed: string[] = [];
  const keys = r.area === null ? Object.keys(ctx.areaLabels) : [r.area];
  const evidence: EvidenceRef[] = [];
  for (const area of keys) {
    let all = true;
    const found: EvidenceRef[] = [];
    for (const w of weeks) {
      const rec = ctx.facts[w]?.record ?? null;
      const row = rec?.scorecard.find((s) => ctx.resolveArea(s.area) === area);
      if (rec === null || row === undefined || row.status !== "missed") {
        all = false;
        break;
      }
      found.push(...refsFor(rec, row.evidenceIds));
    }
    if (all) {
      missed.push(area);
      evidence.push(...found);
    }
  }
  if (missed.length === 0) return ok(rule);
  const names = missed.map((a) => label(ctx, a)).join(", ");
  return breach(rule, `${names} missed ${plural(r.weeks, "week")} in a row`, `The scorecard marked ${names} as missed in each of the last ${plural(r.weeks, "week")} (${weeks[0]} to ${ctx.week}).`, evidence);
}

function areaAbsent(rule: GuardrailRule, r: Of<"area_absent">, ctx: RuleContext): Evaluation {
  const areas = r.areas.map((a) => ctx.resolveArea(a) ?? a);
  for (const w of windowWeeks(ctx, r.weeks)) {
    const mix = ctx.facts[w]?.mix;
    if (mix == null || Object.keys(mix.actual).length === 0) return ok(rule); // no data for that week: cannot say it was absent
    if (areas.reduce((s, a) => s + (mix.actual[a] ?? 0), 0) > 0.0005) return ok(rule);
  }
  const names = areas.map((a) => label(ctx, a)).join(" or ");
  return breach(rule, `No ${names} work for ${plural(r.weeks, "week")}`, `None of the rated days in the last ${plural(r.weeks, "week")} touched ${names}.`);
}

function openAsksAge(rule: GuardrailRule, r: Of<"open_asks_age">, ctx: RuleContext): Evaluation {
  const current = ctx.facts[ctx.week]?.record;
  if (current == null) return skip(rule);
  const prior = previousWeeks(ctx.week, r.weeks - 1).reverse(); // newest first
  const old: Array<{ text: string; weeks: number; ids: string[] }> = [];
  for (const ask of current.openAsks) {
    let text = normalise(ask.text);
    let ids = new Set(ask.evidenceIds);
    let run = 1;
    for (const w of prior) {
      const rec = ctx.facts[w]?.record;
      if (rec == null) break;
      const match = rec.openAsks.find((a) => normalise(a.text) === text || a.evidenceIds.some((id) => ids.has(id)));
      if (match === undefined) break;
      text = normalise(match.text);
      ids = new Set(match.evidenceIds);
      run += 1;
    }
    if (run >= r.weeks) old.push({ text: ask.text, weeks: run, ids: ask.evidenceIds });
  }
  if (old.length === 0) return ok(rule);
  const title = old.length === 1 ? `An ask has been open for ${plural(r.weeks, "week")}: ${old[0]!.text}` : `${old.length} asks have been open for ${plural(r.weeks, "week")} or more`;
  return breach(rule, title, old.map((o) => `"${o.text}"`).join("; "), old.flatMap((o) => refsFor(current, o.ids)));
}

function coverageFailure(rule: GuardrailRule, r: Of<"coverage_failure">, ctx: RuleContext): Evaluation {
  const days = ctx.facts[ctx.week]?.coverageDays ?? [];
  const failures = new Map<string, number>();
  for (const d of days) {
    for (const [source, cov] of Object.entries(d.coverage)) {
      const status = typeof cov === "string" ? cov : cov.status;
      if (status !== "failed") continue; // off, ok and partial never count
      if (typeof cov !== "string" && cov.note === NOT_CAPTURED.note) continue; // never attempted: not a failure
      if (r.source !== null && r.source !== source) continue;
      failures.set(source, (failures.get(source) ?? 0) + 1);
    }
  }
  const bad = [...failures].filter(([, n]) => n >= r.daysPerWeek);
  if (bad.length === 0) return ok(rule);
  const text = bad.map(([s, n]) => `${s} on ${plural(n, "day")}`).join(", ");
  return breach(rule, `Capture failed: ${text}`, `A source that failed on ${r.daysPerWeek} or more days in ${ctx.week} leaves gaps in the record: ${text}.`);
}

function driftOver(rule: GuardrailRule, r: Of<"drift_over">, ctx: RuleContext): Evaluation {
  const s = ctx.snapshot;
  if (s === null) return skip(rule);
  if (!(s.score > r.score)) return ok(rule);
  const worst = Object.entries(s.perArea).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
  const where = worst === undefined ? "" : `: ${label(ctx, worst[0])} is ${Math.abs(worst[1])} points ${worst[1] > 0 ? "over" : "under"} target`;
  return breach(rule, `Time mix is ${s.score} points off target${where}`, `The drift score is ${s.score}, above the ${r.score} limit, over the last ${plural(s.windowWeeks, "week")}.`);
}

function planHitBelow(rule: GuardrailRule, r: Of<"plan_hit_below">, ctx: RuleContext): Evaluation {
  const rates = windowWeeks(ctx, r.weeks).flatMap((w) => {
    const h = ctx.facts[w]?.plan?.hitRate;
    return h == null ? [] : [asPct(h)];
  });
  if (rates.length === 0) return skip(rule);
  const pct = round1(avg(rates));
  if (!(pct < r.pct)) return ok(rule);
  return breach(rule, `Only ${pct}% of planned work got done`, `Below the ${r.pct}% floor, averaged over ${plural(rates.length, "week")} with a plan.`);
}

function areaShare(rule: GuardrailRule, area: string, limit: number, weeks: number, dir: "min" | "max", ctx: RuleContext): Evaluation {
  const key = ctx.resolveArea(area) ?? area;
  const mixes = windowWeeks(ctx, weeks).flatMap((w) => {
    const m = ctx.facts[w]?.mix;
    return m != null && Object.keys(m.actual).length > 0 ? [m] : [];
  });
  if (mixes.length === 0) return skip(rule);
  const share = round1(avg(mixes.map((m) => (m.actual[key] ?? 0) * 100)));
  const breached = dir === "min" ? share < limit : share > limit;
  if (!breached) return ok(rule);
  const name = label(ctx, key);
  return breach(
    rule,
    `${name} is ${share}% of the mix, ${dir === "min" ? "below the minimum" : "above the maximum"} of ${limit}%`,
    `Averaged over ${plural(mixes.length, "week")} with data (estimated from the areas rated days touched, not hours).`,
  );
}

function wipLimit(rule: GuardrailRule, r: Of<"wip_limit">, ctx: RuleContext): Evaluation {
  if (ctx.threads === null || !ctx.isLatest) return skip(rule);
  const active = ctx.threads.filter((t) => !t.hidden && (t.status === "active" || t.status === "at_risk"));
  if (active.length <= r.max) return ok(rule);
  return breach(rule, `${active.length} threads are active at once (limit ${r.max})`, active.map((t) => t.title).slice(0, 10).join("; "));
}

function closureRate(rule: GuardrailRule, r: Of<"closure_rate">, ctx: RuleContext): Evaluation {
  if (ctx.threads === null || !ctx.isLatest) return skip(rule);
  const window = new Set(windowWeeks(ctx, r.weeks));
  const shipped = ctx.threads.filter((t) => !t.hidden && t.status !== "dropped" && t.weeks.some((w) => w.state === "shipped" && window.has(w.week)));
  if (shipped.length === 0) return ok(rule);
  const closedIds = new Set(ctx.closures.map((c) => c.threadId));
  const closed = shipped.filter((t) => t.status === "closed" || closedIds.has(t.id)).length;
  const pct = round1((100 * closed) / shipped.length);
  if (!(pct < r.minPct)) return ok(rule);
  const open = shipped.filter((t) => !(t.status === "closed" || closedIds.has(t.id)));
  return breach(rule, `${closed} of ${shipped.length} shipped threads have a closure note (${pct}%)`, `Below the ${r.minPct}% target over ${plural(r.weeks, "week")}. Waiting: ${open.map((t) => t.title).slice(0, 8).join("; ")}.`);
}

export function evaluateRule(rule: GuardrailRule, ctx: RuleContext): Evaluation {
  const r = rule.rule;
  switch (r.type) {
    case "meeting_load":
      return meetingLoad(rule, r, ctx);
    case "area_missed":
      return areaMissed(rule, r, ctx);
    case "area_absent":
      return areaAbsent(rule, r, ctx);
    case "open_asks_age":
      return openAsksAge(rule, r, ctx);
    case "coverage_failure":
      return coverageFailure(rule, r, ctx);
    case "drift_over":
      return driftOver(rule, r, ctx);
    case "plan_hit_below":
      return planHitBelow(rule, r, ctx);
    case "area_share_min":
      return areaShare(rule, r.area, r.minPct, r.weeks, "min", ctx);
    case "area_share_max":
      return areaShare(rule, r.area, r.maxPct, r.weeks, "max", ctx);
    case "wip_limit":
      return wipLimit(rule, r, ctx);
    case "closure_rate":
      return closureRate(rule, r, ctx);
  }
}

/** One Evaluation per enabled rule. Disabled rules are not evaluated. */
export function evaluateRules(rules: readonly GuardrailRule[], ctx: RuleContext): Evaluation[] {
  return rules.filter((r) => r.enabled).map((r) => evaluateRule(r, ctx));
}

/** The rules a fresh install gets. `handsOnAreas` are the framework's hands_on area keys (the rule is omitted with none). */
export function defaultRules(handsOnAreas: readonly string[]): GuardrailRule[] {
  const rules: GuardrailRule[] = [
    { id: "meeting_load", enabled: true, severity: "warning", rule: { type: "meeting_load", maxPct: 60, weeks: 1 } },
    { id: "area_missed", enabled: true, severity: "warning", rule: { type: "area_missed", area: null, weeks: 3 } },
  ];
  if (handsOnAreas.length > 0) rules.push({ id: "no_hands_on", enabled: true, severity: "info", rule: { type: "area_absent", areas: [...handsOnAreas], weeks: 4 } });
  rules.push(
    { id: "open_asks", enabled: true, severity: "warning", rule: { type: "open_asks_age", weeks: 3 } },
    { id: "source_failing", enabled: true, severity: "info", rule: { type: "coverage_failure", source: null, daysPerWeek: 3 } },
    { id: "too_many_threads", enabled: true, severity: "info", rule: { type: "wip_limit", max: 5 } },
  );
  return rules;
}
