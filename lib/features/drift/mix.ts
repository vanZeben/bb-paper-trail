/**
 * mix.ts — the weekly mix of where the time went, estimated from the areas each rated day touched.
 *
 * Each rated day is one unit, split equally over its `rating.areas` (resolved to current framework keys). Days with
 * no areas contribute nothing. When a week has no day areas at all, the scorecard stands in: hit = 1, partial = 0.5,
 * missed = 0, normalised. `actual` holds fractions (0..1) that sum to 1 whenever there is any signal.
 * Pure: no store, no clock.
 */
import { resolveArea } from "../../framework/rubric";
import type { RoleFramework, WeekMix, WorkDay, WorkWeek } from "../../types";

type Status = "hit" | "partial" | "missed";
const STATUS_WEIGHT: Record<Status, number> = { hit: 1, partial: 0.5, missed: 0 };
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export interface MixTargets {
  targets: Record<string, number>;
}

/** Signed percentage points per area (actual% - target%) for one mix; max |value| is the week's drift. */
export function weekDrift(actual: Record<string, number>, targets: Record<string, number>): number | null {
  if (Object.keys(actual).length === 0) return null;
  const keys = new Set([...Object.keys(actual), ...Object.keys(targets)]);
  let max = 0;
  for (const k of keys) max = Math.max(max, Math.abs((actual[k] ?? 0) * 100 - (targets[k] ?? 0)));
  return Math.round(max * 10) / 10;
}

/** The scorecard as `{ area: status }` with keys resolved to the current framework (unknown areas dropped). */
function scorecardOf(week: Pick<WorkWeek, "scorecard">, framework: RoleFramework): Record<string, Status> {
  const out: Record<string, Status> = {};
  for (const row of week.scorecard) {
    const key = resolveArea(framework, row.area);
    if (key !== null) out[key] = row.status;
  }
  return out;
}

export function weekMix(week: Pick<WorkWeek, "week" | "scorecard">, days: readonly WorkDay[], framework: RoleFramework, targets?: Record<string, number> | null): WeekMix {
  const keys = framework.areas.map((a) => a.key);
  const scorecard = scorecardOf(week, framework);
  const units: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
  let daysCounted = 0;
  for (const day of days) {
    if (day.rating === null) continue;
    const resolved = [...new Set(day.rating.areas.map((a) => resolveArea(framework, a)).filter((a): a is string => a !== null))];
    if (resolved.length === 0) continue;
    daysCounted += 1;
    for (const a of resolved) units[a] = (units[a] ?? 0) + 1 / resolved.length;
  }

  let actual: Record<string, number> = {};
  if (daysCounted > 0) {
    actual = Object.fromEntries(keys.map((k) => [k, round3((units[k] ?? 0) / daysCounted)]));
  } else {
    const weights = keys.map((k) => (scorecard[k] === undefined ? 0 : STATUS_WEIGHT[scorecard[k]]));
    const total = weights.reduce((s, w) => s + w, 0);
    if (total > 0) actual = Object.fromEntries(keys.map((k, i) => [k, round3(weights[i]! / total)]));
  }
  return { week: week.week, daysCounted, actual, scorecard, drift: targets ? weekDrift(actual, targets) : null };
}
