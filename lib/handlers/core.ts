/**
 * handlers/core.ts — diagnostics, the graph reads, run control and onboarding state. Core reads feature *records*
 * directly (never feature code): features write `override`, `addenda`, `plan`, `violation` and `mix` records, and
 * this module shapes them for day.get / week.get.
 */
import { z } from "zod";
import { KIND } from "../storage/port";
import {
  connectorCheckSchema, dayRatingSchema, guardrailResultSchema, overrideSchema, roleFrameworkSchema, weekAddendaSchema, weekMixSchema,
  weekPlanSchema, allocationTargetsSchema, type Override,
} from "../types";
import type { HandlersFn } from "./types";

type Methods = "diag.ping" | "grid.get" | "day.get" | "week.get" | "week.markdown" | "run.start" | "run.status" | "onboarding.get" | "onboarding.complete";

/** meta key holding the onboarding state. */
export const ONBOARDING_META = "onboarding";

const ratingSchema = dayRatingSchema.shape.rating;
const onboardingSchema = z.object({ completed: z.literal(true), at: z.string() });

/** True once onboarding.complete has run. Shared with server.ts (the scheduled tick gate). */
export async function isOnboarded(store: { getMeta(key: string): Promise<string | null> }): Promise<boolean> {
  const raw = await store.getMeta(ONBOARDING_META);
  if (raw === null) return false;
  try {
    return onboardingSchema.safeParse(JSON.parse(raw)).success;
  } catch {
    return false;
  }
}

export const handlers: HandlersFn<Methods> = (ctx, service, env) => {
  const { store } = ctx;

  const weekOverrides = async (week: string): Promise<Override[]> => {
    const own = await store.get(KIND.override, `week:${week}`, overrideSchema);
    const scorecard = await store.list(KIND.override, overrideSchema, { from: `scorecard:${week}:`, to: `scorecard:${week}:￿` });
    return [...(own === null ? [] : [own]), ...scorecard.map((row) => row.value)];
  };

  return {
    "diag.ping": () => env.worker.ping(),

    "grid.get": ({ weeks }) => service.grid(weeks),

    "day.get": async ({ date }) => {
      const day = await service.day(date);
      const [override, weekFinal] = await Promise.all([
        store.get(KIND.override, `day:${date}`, overrideSchema),
        // A date with no day record has no final week.
        day === null ? false : service.weekFinal(day.week),
      ]);
      const overridden = ratingSchema.safeParse(override?.value);
      return {
        day,
        override,
        effectiveRating: overridden.success ? overridden.data : (day?.rating?.rating ?? null),
        weekFinal,
      };
    },

    "week.get": async ({ week }) => {
      const [stored, overrides, addenda, plan, mix, violations] = await Promise.all([
        service.week(week),
        weekOverrides(week),
        store.get(KIND.addenda, week, weekAddendaSchema),
        store.get(KIND.plan, week, weekPlanSchema),
        store.get(KIND.mix, week, weekMixSchema),
        store.list(KIND.violation, guardrailResultSchema),
      ]);
      return {
        week: stored,
        overrides,
        addenda: addenda ?? weekAddendaSchema.parse({ week, updatedAt: "" }),
        plan,
        violations: violations.map((row) => row.value).filter((v) => v.id.endsWith(`:${week}`)),
        mix,
      };
    },

    "week.markdown": ({ week }) => service.weekMarkdown(week),

    "run.start": async (input) => {
      await service.run(input);
      return { ok: true as const };
    },

    "run.status": () => service.status(),

    "onboarding.get": async () => {
      const [completed, connectors, framework, targets, index] = await Promise.all([
        isOnboarded(store),
        store.get(KIND.connectors, "latest", connectorCheckSchema),
        store.get(KIND.framework, "active", roleFrameworkSchema),
        store.get(KIND.targets, "active", allocationTargetsSchema),
        service.index(),
      ]);
      return {
        completed,
        steps: {
          connectors: connectors !== null,
          framework: framework !== null,
          targets: targets !== null,
          firstRun: Object.keys(index.days).length > 0,
        },
      };
    },

    "onboarding.complete": async () => {
      await store.setMeta(ONBOARDING_META, JSON.stringify({ completed: true, at: ctx.now().toISOString() }));
      ctx.publish();
      return { ok: true as const };
    },
  };
};
