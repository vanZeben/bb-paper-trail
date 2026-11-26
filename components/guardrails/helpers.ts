// UI-side helpers for guardrails. Type-only imports from lib (no zod / SDK in the app bundle).
import { SOURCE_LABEL, SOURCE_ORDER } from "../settings/sourceMeta";
import type { GuardrailResult, GuardrailRule, Severity } from "../../lib/types";

type Rule = GuardrailRule["rule"];
export type RuleType = Rule["type"];

/** Severity -> icon, label and tone. Never colour alone: the banner shows the icon and the label. */
export const SEVERITY_META: Record<Severity, { icon: string; label: string; tone: string; border: string }> = {
  info: { icon: "Info", label: "Heads up", tone: "bg-sky-500/15 text-sky-700 dark:text-sky-300", border: "border-sky-500/40" },
  warning: { icon: "TriangleAlert", label: "Warning", tone: "bg-amber-500/15 text-amber-700 dark:text-amber-300", border: "border-amber-500/40" },
  breach: { icon: "OctagonAlert", label: "Breach", tone: "bg-red-500/15 text-red-700 dark:text-red-300", border: "border-red-500/40" },
};
export const SEVERITIES: readonly Severity[] = ["info", "warning", "breach"];
export const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, breach: 2 };

/** Per rule, the newest open result, worst severity first (then newest week). */
export function currentResults(results: readonly GuardrailResult[]): GuardrailResult[] {
  const latest = new Map<string, GuardrailResult>();
  for (const r of results) {
    if (r.state !== "open") continue;
    const prev = latest.get(r.ruleId);
    if (prev === undefined || r.week > prev.week) latest.set(r.ruleId, r);
  }
  return [...latest.values()].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || (a.week < b.week ? 1 : -1) || (a.id < b.id ? -1 : 1));
}

/** "W46" or "W44 to W46": the weeks a breach spans. */
export const weekSpan = (r: Pick<GuardrailResult, "week" | "firstBreachedWeek">): string => {
  const short = (w: string) => w.replace(/^\d{4}-/, "");
  return r.firstBreachedWeek === r.week ? short(r.week) : `${short(r.firstBreachedWeek)} to ${short(r.week)}`;
};

// ─── rule editing ───────────────────────────────────────────────────────────
export const SOURCE_OPTIONS: ReadonlyArray<{ id: string; label: string }> = SOURCE_ORDER.map((id) => ({ id, label: SOURCE_LABEL[id] ?? id }));

export type Field =
  | { kind: "num"; key: string; label: string; min: number; max: number; unit: string }
  | { kind: "area"; key: string; label: string; nullable: boolean }
  | { kind: "areas"; key: string; label: string }
  | { kind: "source"; key: string; label: string };

const weeks = (max: number, label = "Weeks"): Field => ({ kind: "num", key: "weeks", label, min: 1, max, unit: "weeks" });

export const RULE_TYPES: ReadonlyArray<{ type: RuleType; label: string; fields: readonly Field[] }> = [
  { type: "meeting_load", label: "Too many meetings", fields: [{ kind: "num", key: "maxPct", label: "More than", min: 1, max: 100, unit: "% of the week" }, weeks(8, "Averaged over")] },
  { type: "area_missed", label: "Area missed repeatedly", fields: [{ kind: "area", key: "area", label: "Area", nullable: true }, weeks(12, "In a row for")] },
  { type: "area_absent", label: "No work in an area", fields: [{ kind: "areas", key: "areas", label: "Areas" }, weeks(12, "For")] },
  { type: "open_asks_age", label: "Asks left open", fields: [weeks(12, "Open for")] },
  { type: "coverage_failure", label: "A source keeps failing", fields: [{ kind: "source", key: "source", label: "Source" }, { kind: "num", key: "daysPerWeek", label: "Failing on", min: 1, max: 5, unit: "days a week" }] },
  { type: "drift_over", label: "Drifting from targets", fields: [{ kind: "num", key: "score", label: "Drift score over", min: 1, max: 100, unit: "points" }] },
  { type: "plan_hit_below", label: "Plan follow-through low", fields: [{ kind: "num", key: "pct", label: "Hit rate below", min: 0, max: 100, unit: "%" }, weeks(8, "Averaged over")] },
  { type: "area_share_min", label: "Area share too small", fields: [{ kind: "area", key: "area", label: "Area", nullable: false }, { kind: "num", key: "minPct", label: "Less than", min: 0, max: 100, unit: "% of time" }, weeks(12, "Averaged over")] },
  { type: "area_share_max", label: "Area share too large", fields: [{ kind: "area", key: "area", label: "Area", nullable: false }, { kind: "num", key: "maxPct", label: "More than", min: 0, max: 100, unit: "% of time" }, weeks(12, "Averaged over")] },
  { type: "wip_limit", label: "Too many active threads", fields: [{ kind: "num", key: "max", label: "More than", min: 1, max: 50, unit: "threads" }] },
  { type: "closure_rate", label: "Shipped work without a closure note", fields: [{ kind: "num", key: "minPct", label: "Closure notes below", min: 0, max: 100, unit: "%" }, weeks(26, "Over")] },
];
export const ruleTypeLabel = (type: RuleType): string => RULE_TYPES.find((t) => t.type === type)?.label ?? type;

/** A rule of `type` with sensible defaults; `firstArea` seeds the area-bound types. */
export function defaultRule(type: RuleType, firstArea: string): Rule {
  switch (type) {
    case "meeting_load": return { type, maxPct: 60, weeks: 1 };
    case "area_missed": return { type, area: null, weeks: 3 };
    case "area_absent": return { type, areas: [firstArea], weeks: 4 };
    case "open_asks_age": return { type, weeks: 3 };
    case "coverage_failure": return { type, source: null, daysPerWeek: 3 };
    case "drift_over": return { type, score: 30 };
    case "plan_hit_below": return { type, pct: 50, weeks: 2 };
    case "area_share_min": return { type, area: firstArea, minPct: 10, weeks: 4 };
    case "area_share_max": return { type, area: firstArea, maxPct: 50, weeks: 4 };
    case "wip_limit": return { type, max: 5 };
    case "closure_rate": return { type, minPct: 50, weeks: 8 };
  }
}

/** A rule id not in `taken`: the type name, then `_2`, `_3`... */
export function uniqueRuleId(type: RuleType, taken: readonly string[]): string {
  if (!taken.includes(type)) return type;
  let n = 2;
  while (taken.includes(`${type}_${n}`)) n += 1;
  return `${type}_${n}`;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One plain sentence per rule, e.g. "Warn when meetings take more than 60% of the week." */
export function describeRule(rule: Rule, labelOf: (key: string) => string = (k) => k): string {
  switch (rule.type) {
    case "meeting_load":
      return `Meetings take more than ${rule.maxPct}% of ${rule.weeks === 1 ? "the week" : `working time, averaged over ${plural(rule.weeks, "week")}`}.`;
    case "area_missed":
      return `${rule.area === null ? "Any area is" : `${labelOf(rule.area)} is`} marked missed for ${plural(rule.weeks, "week")} in a row.`;
    case "area_absent":
      return `No work in ${rule.areas.map(labelOf).join(" or ")} for ${plural(rule.weeks, "week")}.`;
    case "open_asks_age":
      return `An ask stays open for ${plural(rule.weeks, "week")} or more.`;
    case "coverage_failure":
      return `${rule.source === null ? "A source" : (SOURCE_OPTIONS.find((s) => s.id === rule.source)?.label ?? rule.source)} fails to capture on ${plural(rule.daysPerWeek, "day")} in a week.`;
    case "drift_over":
      return `Time drifts from your targets by more than ${rule.score} points.`;
    case "plan_hit_below":
      return `Plan hit rate falls below ${rule.pct}%, averaged over ${plural(rule.weeks, "week")}.`;
    case "area_share_min":
      return `${labelOf(rule.area)} gets less than ${rule.minPct}% of your time, averaged over ${plural(rule.weeks, "week")}.`;
    case "area_share_max":
      return `${labelOf(rule.area)} takes more than ${rule.maxPct}% of your time, averaged over ${plural(rule.weeks, "week")}.`;
    case "wip_limit":
      return `More than ${plural(rule.max, "thread")} are active at once.`;
    case "closure_rate":
      return `Fewer than ${rule.minPct}% of shipped threads have a closure note, over ${plural(rule.weeks, "week")}.`;
  }
}
