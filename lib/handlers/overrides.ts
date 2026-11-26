/** handlers/overrides.ts — override.set / override.clear / override.stats. Thin: the rules are in features/overrides/logic.ts. */
import { isoWeekOf, localToday, previousWeeks } from "../engine/dates";
import { listOverrides } from "../features/overrides";
import { assertAllowed, buildOverride, computeStats, inWeeks, overrideId } from "../features/overrides/logic";
import { KIND } from "../storage/port";
import type { OverrideTarget } from "../types";
import type { HandlersFn } from "./types";

type Methods = "override.set" | "override.clear" | "override.stats";

export const handlers: HandlersFn<Methods> = (ctx, service, _env) => {
  /** The AI's current value for a target, or throws when there is nothing to review. */
  const aiValueOf = async (target: OverrideTarget): Promise<string> => {
    if (target.type === "day") {
      const day = await service.day(target.date);
      if (day?.rating == null) throw new Error(`No AI rating for ${target.date} yet`);
      return day.rating.rating;
    }
    const week = await service.week(target.week);
    if (week === null) throw new Error(`No report for ${target.week} yet`);
    if (target.type === "week") return week.rating;
    const row = week.scorecard.find((s) => s.area === target.area);
    if (row === undefined) throw new Error(`${target.week} has no scorecard row for ${target.area}`);
    return row.status;
  };

  return {
    "override.set": async ({ target, value, note }) => {
      assertAllowed(target, value);
      const override = buildOverride({ target, value, note, aiValue: await aiValueOf(target), now: ctx.now() });
      await ctx.store.set(KIND.override, override.id, override);
      ctx.publish();
      return { override };
    },

    "override.clear": async ({ target }) => {
      await ctx.store.delete(KIND.override, overrideId(target));
      ctx.publish();
      return { ok: true as const };
    },

    "override.stats": async ({ weeks }) => {
      const current = isoWeekOf(localToday(ctx.now(), ctx.settings().timeZone));
      const window = [...previousWeeks(current, Math.max(1, weeks) - 1), current];
      const set = new Set(window);
      const all = inWeeks(await listOverrides(ctx), set);
      const index = await service.index();
      const reviewable: string[] = [];
      for (const [date, day] of Object.entries(index.days)) {
        if (set.has(isoWeekOf(date)) && day.rating !== null && day.rating !== "none") reviewable.push(`day:${date}`);
      }
      for (const week of window) {
        if (index.weeks[week] === undefined) continue;
        reviewable.push(`week:${week}`);
        const record = await service.week(week);
        for (const row of record?.scorecard ?? []) reviewable.push(`scorecard:${week}:${row.area}`);
      }
      return computeStats(all, reviewable);
    },
  };
};
