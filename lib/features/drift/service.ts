/**
 * service.ts — store-backed drift helpers shared by the hook, the grid contributor and the handler.
 * Mix records are the source of truth; snapshots are recomputed from them against the *current* targets, so editing
 * the targets takes effect without re-running any week.
 */
import { addDays, previousWeeks, weekDates } from "../../engine/dates";
import type { FeatureCtx } from "../../engine/extensions";
import { KIND, type Store } from "../../storage/port";
import { allocationTargetsSchema, weekMixSchema, workDaySchema, type AllocationTargets, type DriftSnapshot, type RoleFramework, type WeekMix, type WorkWeek } from "../../types";
import { weekDrift, weekMix } from "./mix";
import { driftSnapshot } from "./snapshot";

export const TARGETS_ID = "active";

export const loadTargets = (store: Store): Promise<AllocationTargets | null> => store.get(KIND.targets, TARGETS_ID, allocationTargetsSchema);

/** The weeks in a window ending at `week`, oldest first. */
export const windowOf = (week: string, n: number): string[] => [...previousWeeks(week, Math.max(1, n) - 1), week];

/** All stored mixes from `from` to `to` (inclusive week ids), keyed by week. */
export async function loadMixes(store: Store, from: string, to: string): Promise<Map<string, WeekMix>> {
  const rows = await store.list(KIND.mix, weekMixSchema, { from, to });
  return new Map(rows.map((r) => [r.id, r.value]));
}

/** Snapshot for the window ending at `week`, from already-loaded mixes. */
export function snapshotFrom(week: string, mixes: Map<string, WeekMix>, targets: AllocationTargets, now: Date): DriftSnapshot | null {
  const inWindow = windowOf(week, targets.windowWeeks)
    .map((w) => mixes.get(w))
    .filter((m): m is WeekMix => m !== undefined);
  return driftSnapshot(week, inWindow, targets, now.toISOString());
}

/** Snapshot ending at `week`, computed live from stored mixes and the current targets. Null without targets or data. */
export async function snapshotAt(store: Store, week: string, now: Date, targets?: AllocationTargets | null): Promise<DriftSnapshot | null> {
  const t = targets === undefined ? await loadTargets(store) : targets;
  if (t === null) return null;
  const ids = windowOf(week, t.windowWeeks);
  return snapshotFrom(week, await loadMixes(store, ids[0]!, week), t, now);
}

/** Mix for one saved week from its stored days (rating areas), against the active targets when there are any. */
export async function computeMix(store: Store, week: Pick<WorkWeek, "week" | "scorecard">, framework: RoleFramework, targets: AllocationTargets | null): Promise<WeekMix> {
  const dates = weekDates(week.week);
  const days = (await store.list(KIND.day, workDaySchema, { from: dates[0], to: addDays(dates[0]!, 6) })).map((r) => r.value);
  return weekMix(week, days, framework, targets?.targets ?? null);
}

/** Writes `mix` (and `drift` when targets exist and there is data) for a saved week. */
export async function updateWeek(ctx: FeatureCtx, week: WorkWeek): Promise<void> {
  const targets = await loadTargets(ctx.store);
  const mix = await computeMix(ctx.store, week, await ctx.framework(), targets);
  await ctx.store.set(KIND.mix, week.week, mix);
  if (targets !== null) {
    const snapshot = await snapshotAt(ctx.store, week.week, ctx.now(), targets);
    if (snapshot !== null) await ctx.store.set(KIND.drift, week.week, snapshot);
  }
  ctx.publish();
}

/** Re-derive every mix's `drift` field against the current targets (cheap; used when reading). */
export const withDrift = (mix: WeekMix, targets: AllocationTargets | null): WeekMix => ({ ...mix, drift: targets ? weekDrift(mix.actual, targets.targets) : null });
