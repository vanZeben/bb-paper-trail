import type { Registry } from "../../engine/extensions";
import type { GridV2 } from "../../types";
import { loadMixes, loadTargets, snapshotFrom, updateWeek, windowOf } from "./service";

/**
 * Drift feature: a week hook writes the week's mix (KIND.mix, id = week) and drift snapshot (KIND.drift, id = week);
 * a grid contributor sets `markers.drift` from the mixes and the *current* targets.
 */
export function register(reg: Registry): void {
  reg.weekHooks.push({ id: "drift", afterWeekSaved: (week, ctx) => updateWeek(ctx, week) });
  reg.grid.push({
    id: "drift",
    async contribute(grid: GridV2, ctx) {
      const targets = await loadTargets(ctx.store);
      if (targets === null || grid.weeks.length === 0) return;
      const first = windowOf(grid.weeks[0]!.week, targets.windowWeeks)[0]!;
      const mixes = await loadMixes(ctx.store, first, grid.weeks[grid.weeks.length - 1]!.week);
      const now = ctx.now();
      for (const w of grid.weeks) {
        if (!mixes.has(w.week)) continue;
        const status = snapshotFrom(w.week, mixes, targets, now)?.status;
        w.markers.drift = status === "watch" || status === "off" ? status : null;
      }
    },
  });
}
