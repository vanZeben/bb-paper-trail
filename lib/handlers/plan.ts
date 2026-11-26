/** handlers/plan.ts — plan.get / set / push / stats over the `plan` records (id = ISO week). */
import { isoWeekOf, isValidWeek, localToday, previousWeeks } from "../engine/dates";
import { planWeekNow } from "../features/plan";
import { planAccuracy } from "../features/plan/marks";
import { hitRate, buildItems, emptyPlan, planStats, pushItems } from "../features/plan/logic";
import { areaKeys } from "../framework/rubric";
import { KIND } from "../storage/port";
import { weekPlanSchema, type WeekPlan } from "../types";
import type { HandlersFn } from "./types";

type Methods = "plan.get" | "plan.set" | "plan.push" | "plan.stats" | "plan.now" | "plan.accuracy";

export const handlers: HandlersFn<Methods> = (ctx, _service, _env) => {
  const load = async (week: string): Promise<WeekPlan> => (await ctx.store.get(KIND.plan, week, weekPlanSchema)) ?? emptyPlan(week);
  const save = async (plan: WeekPlan): Promise<WeekPlan> => {
    // Results of items that are gone stop counting; a judged week keeps a live hit rate.
    const ids = new Set(plan.items.map((i) => i.id));
    const results = plan.results.filter((r) => ids.has(r.itemId));
    const next: WeekPlan = { ...plan, results, hitRate: plan.judgedAt === null ? null : hitRate(plan.items, results) };
    await ctx.store.set(KIND.plan, next.week, next);
    ctx.publish();
    return next;
  };

  return {
    "plan.get": ({ week }) => load(week),

    "plan.set": async ({ week, items }) => {
      const [current, prev] = await Promise.all([load(week), load(previousWeeks(week, 1)[0]!)]);
      const keys = new Set(areaKeys(await ctx.framework()));
      const clean = items.map((i) => ({ ...i, area: i.area != null && keys.has(i.area) ? i.area : null }));
      const built = buildItems(week, clean, current.items, prev, ctx.now().toISOString());
      return save({ ...current, items: built });
    },

    "plan.push": async ({ week, items }) => {
      const current = await load(week);
      const { items: next, added, skipped } = pushItems(week, current.items, items, ctx.now().toISOString());
      if (skipped > 0) ctx.log.info(`plan.push ${week}: added ${added}, skipped ${skipped} (duplicate ref, blank or week full)`);
      if (added > 0) await save({ ...current, items: next });
      return { ok: true as const };
    },

    // Returns at once; the scan runs in the background and the app re-reads when it publishes.
    "plan.now": ({ week }) => {
      if (week !== undefined && !isValidWeek(week)) throw new Error(`${week} is not a real week.`);
      void planWeekNow(ctx, week, "manual_trigger");
      return { ok: true as const };
    },

    "plan.accuracy": async ({ weeks }) => {
      const current = isoWeekOf(localToday(ctx.now(), ctx.settings().timeZone));
      const window = [...previousWeeks(current, weeks - 1), current];
      const rows = await ctx.store.list(KIND.plan, weekPlanSchema, { from: window[0]!, to: window[window.length - 1]! });
      return planAccuracy(rows.map((r) => r.value));
    },

    "plan.stats": async ({ weeks }) => {
      const current = isoWeekOf(localToday(ctx.now(), ctx.settings().timeZone));
      const window = [...previousWeeks(current, weeks - 1), current];
      const rows = await ctx.store.list(KIND.plan, weekPlanSchema, { from: window[0]!, to: window[window.length - 1]! });
      return planStats(rows.map((r) => r.value));
    },
  };
};
