/**
 * overrides — confirm or change the AI's ratings. Records live under KIND.override (`day:<date>`, `week:<week>`,
 * `scorecard:<week>:<area>`); the AI's own day and week records are never written here. This module adds:
 * - day and week hooks that flag `aiChangedSince` when a re-rating moves the AI value away from the reviewed one;
 * - a grid contributor that applies the effective rating to the cells;
 * - a prompt extension that feeds the user's newest corrections back as calibration.
 */
import type { FeatureCtx, PromptExtension, Registry } from "../../engine/extensions";
import { KIND } from "../../storage/port";
import { overrideSchema, type Override } from "../../types";
import { applyOverridesToGrid, calibrationBlock, overrideId, reconcile } from "./logic";

/** All override records, newest id range first is not needed: callers sort. */
export async function listOverrides(ctx: Pick<FeatureCtx, "store">, opts?: { from?: string; to?: string }): Promise<Override[]> {
  return (await ctx.store.list(KIND.override, overrideSchema, opts)).map((row) => row.value);
}

async function flag(ctx: FeatureCtx, id: string, currentAi: string | null): Promise<boolean> {
  const stored = await ctx.store.get(KIND.override, id, overrideSchema);
  if (stored === null) return false;
  const next = reconcile(stored, currentAi);
  if (next === null) return false;
  await ctx.store.set(KIND.override, id, next);
  return true;
}

const calibration: PromptExtension = {
  id: "overrides",
  async dayRules(ctx) {
    return calibrationBlock(await listOverrides(ctx));
  },
  async weekRules(ctx) {
    return calibrationBlock(await listOverrides(ctx));
  },
};

export function register(reg: Registry): void {
  reg.prompts.push(calibration);
  reg.dayHooks.push({
    id: "overrides",
    async afterDayRated(day, ctx) {
      if (day.rating === null) return;
      if (await flag(ctx, overrideId({ type: "day", date: day.date }), day.rating.rating)) ctx.publish();
    },
  });
  reg.weekHooks.push({
    id: "overrides",
    async afterWeekSaved(week, ctx) {
      let changed = await flag(ctx, overrideId({ type: "week", week: week.week }), week.rating);
      for (const row of week.scorecard) {
        if (await flag(ctx, overrideId({ type: "scorecard", week: week.week, area: row.area }), row.status)) changed = true;
      }
      if (changed) ctx.publish();
    },
  });
  reg.grid.push({
    id: "overrides",
    async contribute(grid, ctx) {
      const first = grid.weeks[0]?.from;
      const last = grid.weeks[grid.weeks.length - 1]?.week;
      if (first === undefined || last === undefined) return;
      const days = await listOverrides(ctx, { from: `day:${first}`, to: "day:￿" });
      const weeks = await listOverrides(ctx, { from: `week:${grid.weeks[0]!.week}`, to: `week:${last}` });
      applyOverridesToGrid(grid, [...days, ...weeks]);
    },
  });
}
