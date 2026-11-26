/** Shared test fixtures: complete plan items, week plans and goals with every defaulted field filled in. */
import { planItemSchema, weekPlanSchema, goalSchema, type Goal, type PlanItem, type WeekPlan } from "../lib/types";

const AT = "2026-11-09T12:00:00Z";

/** A manual plan item with the commitment fields at their defaults. */
export const planItem = (over: Partial<PlanItem> & { id?: string; week?: string } = {}): PlanItem =>
  planItemSchema.parse({ id: "a", week: "2026-W46", text: "Item", area: null, source: "manual", externalRef: null, carriedFrom: null, carryCount: 0, createdAt: AT, ...over });

/** A week plan with the week-scan fields at their defaults. */
export const weekPlan = (over: Partial<WeekPlan> & { week?: string } = {}): WeekPlan =>
  weekPlanSchema.parse({ week: "2026-W46", items: [], results: [], hitRate: null, judgedAt: null, ...over });

/** A goal with no tasks unless given. */
export const goalOf = (over: Partial<Goal> & { id?: string } = {}): Goal =>
  goalSchema.parse({ id: "g1", text: "x", area: null, source: "user", basis: null, createdAt: "", ...over });
