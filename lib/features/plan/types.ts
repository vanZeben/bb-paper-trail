/** Type-only re-exports so logic.ts stays free of zod at runtime. */
import type { planItemSchema, planResultSchema, weekPlanSchema } from "../../types";
import type { z } from "zod";

export type PlanItem = z.infer<typeof planItemSchema>;
export type PlanResult = z.infer<typeof planResultSchema>;
export type WeekPlan = z.infer<typeof weekPlanSchema>;
