/** handlers/drift.ts — `drift.get`: the recent weekly mixes plus the drift snapshot, recomputed against the current targets. */
import { isoWeekOf, localToday, previousWeeks } from "../engine/dates";
import { loadMixes, loadTargets, snapshotFrom, windowOf, withDrift } from "../features/drift/service";
import { KIND } from "../storage/port";
import { driftSnapshotSchema } from "../types";
import type { HandlersFn } from "./types";

type Methods = "drift.get";

export const handlers: HandlersFn<Methods> = (ctx) => ({
  "drift.get": async ({ weeks }) => {
    const now = ctx.now();
    const current = isoWeekOf(localToday(now, ctx.settings().timeZone));
    const ids = [...previousWeeks(current, weeks - 1), current];
    const targets = await loadTargets(ctx.store);
    // Also load the window before the first shown week so every shown week's rolling score has its full window.
    const from = targets === null ? ids[0]! : windowOf(ids[0]!, targets.windowWeeks)[0]!;
    const mixes = await loadMixes(ctx.store, from, current);
    const mix = ids.map((w) => mixes.get(w)).filter((m) => m !== undefined).map((m) => withDrift(m, targets));
    let snapshot = null;
    if (targets !== null) {
      const latest = mix.length > 0 ? mix[mix.length - 1]!.week : current;
      snapshot = snapshotFrom(latest, mixes, targets, now);
      snapshot ??= await ctx.store.get(KIND.drift, latest, driftSnapshotSchema);
    }
    return { mix, snapshot, method: "day_areas" as const };
  },
});
