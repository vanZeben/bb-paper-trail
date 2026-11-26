/**
 * snapshot.ts — drift of the recent mix against the targets. Type-only imports, so the UI can use it too.
 *
 * Per-area drift is signed percentage points (actual% - target%, rounded to 0.1). The score is the largest absolute
 * drift. Window averaging: each week in the window that has any mix signal counts equally.
 */
import type { AllocationTargets, DriftSnapshot, WeekMix } from "../../types";

const round1 = (n: number): number => Math.round(n * 10) / 10;

export type DriftStatus = DriftSnapshot["status"];
export const statusOf = (score: number, thresholds: AllocationTargets["thresholds"]): DriftStatus =>
  score >= thresholds.off ? "off" : score >= thresholds.watch ? "watch" : "aligned";

/** Equal-weight average (in percent) of the mixes that carry a signal; null when none do. */
export function averageActual(mixes: readonly Pick<WeekMix, "actual">[]): Record<string, number> | null {
  const withData = mixes.filter((m) => Object.keys(m.actual).length > 0);
  if (withData.length === 0) return null;
  const sum: Record<string, number> = {};
  for (const m of withData) for (const [k, v] of Object.entries(m.actual)) sum[k] = (sum[k] ?? 0) + v * 100;
  return Object.fromEntries(Object.entries(sum).map(([k, v]) => [k, round1(v / withData.length)]));
}

/** `mixes` are the weeks inside the window (any order). Returns null without data. */
export function driftSnapshot(
  week: string,
  mixes: readonly WeekMix[],
  targets: Pick<AllocationTargets, "targets" | "thresholds" | "windowWeeks">,
  computedAt: string,
): DriftSnapshot | null {
  const actual = averageActual(mixes);
  if (actual === null) return null;
  const keys = [...new Set([...Object.keys(actual), ...Object.keys(targets.targets)])].sort();
  const perArea: Record<string, number> = {};
  const full: Record<string, number> = {};
  const target: Record<string, number> = {};
  for (const k of keys) {
    full[k] = actual[k] ?? 0;
    target[k] = targets.targets[k] ?? 0;
    perArea[k] = round1(full[k]! - target[k]!);
  }
  let score = 0;
  let over: string | null = null;
  let under: string | null = null;
  for (const k of keys) {
    const d = perArea[k]!;
    score = Math.max(score, Math.abs(d));
    if (d > 0 && (over === null || d > perArea[over]!)) over = k;
    if (d < 0 && (under === null || d < perArea[under]!)) under = k;
  }
  return {
    week,
    windowWeeks: targets.windowWeeks,
    actual: full,
    target,
    perArea,
    score: round1(score),
    status: statusOf(round1(score), targets.thresholds),
    biggestOver: over,
    biggestUnder: under,
    computedAt,
  };
}
