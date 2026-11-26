/**
 * plan — the week's intent and commitments, and their marks.
 * Records: `plan` id = ISO week (weekPlanSchema).
 * - The week scan (auto.ts) plans the week: from the tick (Monday 07:00 local, catch-up to Wednesday), after setup, and on
 *   request (plan.now). A plan with the user's own items is never overwritten.
 * - The judge returns `plan[]` (each commitment against its doneWhen) and `planRetro` (two PromptExtensions); a WeekHook
 *   stores the results, the hit rate, the retro and the unplanned share; a GridContributor fills planAdvanced,
 *   markers.planHitRate and lensAvailability.plan.
 */
import { isoWeekOf, localToday, previousWeeks } from "../../engine/dates";
import type { FeatureCtx, PromptCtx, PromptExtension, Registry } from "../../engine/extensions";
import { KIND } from "../../storage/port";
import { goalsSchema, planResultSchema, profileSchema, weekPlanSchema, workDaySchema, workWeekSchema, type Goals, type WeekPlan } from "../../types";
import { refreshGoalTasks } from "../goals/tasks";
import { autoPlanDue, inferredItems, isReplaceable, planAutoKey, planWeekJob, TASKS_STALE_DAYS, weekToPlan, type LastWeekMark, type ScanGoal } from "./auto";
import { advancedByDate, emptyPlan, hitRate, validatePlanResults } from "./logic";
import { PLAN_REPLY_EXAMPLE, planRules } from "./rules";
import { planAccuracy, RETRO_REPLY_EXAMPLE, RETRO_RULES, unplannedShare, validateRetro } from "./marks";
import type { PlanResult } from "./types";

export type PlannedFor = NonNullable<WeekPlan["plannedFor"]>;
export type PlanOutcome = "planned" | "skipped" | "busy" | "failed";

interface WeekState {
  itemIds: Set<string>;
  evidenceIds: Set<string>;
}

/** Reads what the validators need: the week's plan item ids and evidence ids. */
async function loadWeekState(ctx: PromptCtx): Promise<{ plan: WeekPlan | null; state: WeekState }> {
  const plan = await ctx.store.get(KIND.plan, ctx.week, weekPlanSchema);
  const days = await Promise.all(ctx.dates.map((d) => ctx.store.get(KIND.day, d, workDaySchema)));
  return {
    plan,
    state: {
      itemIds: new Set((plan?.items ?? []).map((i) => i.id)),
      evidenceIds: new Set(days.flatMap((d) => (d === null ? [] : d.evidence.map((e) => e.id)))),
    },
  };
}

/** weekRules runs before the judge call and reads the store; the sync validator then reads what it found. */
export function createPlanPrompt(): PromptExtension {
  const byCtx = new WeakMap<PromptCtx, WeekState>();
  const byWeek = new Map<string, WeekState>();

  return {
    id: "plan",
    async weekRules(ctx) {
      const { plan, state } = await loadWeekState(ctx);
      byCtx.set(ctx, state);
      byWeek.set(ctx.week, state);
      const labels = new Map(ctx.framework.areas.map((a) => [a.key, a.label]));
      return planRules(plan?.items ?? [], (k) => labels.get(k) ?? k);
    },
    weekReplyExample(ctx) {
      const state = byCtx.get(ctx) ?? byWeek.get(ctx.week);
      return state !== undefined && state.itemIds.size > 0 ? PLAN_REPLY_EXAMPLE : "";
    },
    validateWeekExtra(raw, ctx) {
      const state = byCtx.get(ctx) ?? byWeek.get(ctx.week) ?? { itemIds: new Set<string>(), evidenceIds: new Set<string>() };
      return validatePlanResults(raw, state);
    },
  };
}

/** The retro half of the marks: stored at week.ext.planRetro. Only asked for when the week has commitments. */
export function createRetroPrompt(): PromptExtension {
  const byCtx = new WeakMap<PromptCtx, WeekState>();
  const byWeek = new Map<string, WeekState>();
  return {
    id: "planRetro",
    async weekRules(ctx) {
      const { state } = await loadWeekState(ctx);
      byCtx.set(ctx, state);
      byWeek.set(ctx.week, state);
      return state.itemIds.size > 0 ? RETRO_RULES : "";
    },
    weekReplyExample(ctx) {
      const state = byCtx.get(ctx) ?? byWeek.get(ctx.week);
      return state !== undefined && state.itemIds.size > 0 ? RETRO_REPLY_EXAMPLE : "";
    },
    validateWeekExtra(raw, ctx) {
      const state = byCtx.get(ctx) ?? byWeek.get(ctx.week);
      return validateRetro(raw, state?.evidenceIds ?? new Set<string>());
    },
  };
}

/**
 * The marks: results (each commitment against its doneWhen), hit rate, the retro, and the share of substantive evidence
 * that no commitment's result cites.
 */
export async function copyResults(
  week: { week: string; ext: Record<string, unknown>; plan: PlanResult[]; evidence?: ReadonlyArray<{ id: string; kind: string }> },
  ctx: FeatureCtx,
): Promise<void> {
  const plan = await ctx.store.get(KIND.plan, week.week, weekPlanSchema);
  if (plan === null || plan.items.length === 0) return;
  const parsed = planResultSchema.array().safeParse(Array.isArray(week.ext.plan) ? week.ext.plan : week.plan);
  const ids = new Set(plan.items.map((i) => i.id));
  const results = (parsed.success ? parsed.data : []).filter((r) => ids.has(r.itemId));
  const retro = weekPlanSchema.shape.retro.safeParse(week.ext.planRetro);
  await ctx.store.set(KIND.plan, week.week, {
    ...plan,
    results,
    hitRate: hitRate(plan.items, results),
    judgedAt: ctx.now().toISOString(),
    retro: retro.success ? retro.data : null,
    unplannedShare: unplannedShare(week.evidence ?? [], results),
  });
  ctx.publish();
}

const MARK: Record<PlanResult["status"], string> = { done: "Hit", partial: "Partial", not_done: "Missed", dropped: "Dropped" };

/** Last week's commitments with their marks, and the derailers; null when there was no plan. */
export function lastWeekMarks(prev: WeekPlan | null): { marks: LastWeekMark[]; derailers: string[] } | null {
  if (prev === null || prev.items.length === 0) return null;
  const judged = prev.judgedAt !== null;
  return {
    marks: prev.items.map((i) => {
      const r = prev.results.find((x) => x.itemId === i.id);
      return { text: i.text, doneWhen: i.doneWhen, mark: r ? MARK[r.status] : judged ? "Missed" : "Unjudged" };
    }),
    derailers: (prev.retro?.derailers ?? []).map((d) => d.text),
  };
}

const DAY_MS = 86_400_000;
const TASKS_RETRY_MINUTES = 10;
const readGoals = async (ctx: FeatureCtx): Promise<Goals> => (await ctx.store.get(KIND.goals, "active", goalsSchema)) ?? { version: 1, goals: [], tasksRefreshedAt: null };

/** Refreshes the goal tasks when they are older than six days (or never made), or when a goal has none (at most once per ten minutes). A failure is logged, never fatal. */
async function ensureGoalTasks(ctx: FeatureCtx): Promise<Goals> {
  const goals = await readGoals(ctx);
  if (goals.goals.length === 0) return goals;
  const at = goals.tasksRefreshedAt === null ? Number.NaN : Date.parse(goals.tasksRefreshedAt);
  const age = ctx.now().getTime() - at;
  // A refresh in the last ten minutes is never repeated, so a goal the job leaves without tasks cannot loop.
  if (!Number.isNaN(at) && age < TASKS_RETRY_MINUTES * 60_000) return goals;
  const bare = goals.goals.some((g) => g.tasks.length === 0);
  if (!Number.isNaN(at) && age < TASKS_STALE_DAYS * DAY_MS && !bare) return goals;
  try {
    await refreshGoalTasks(ctx);
  } catch (cause) {
    ctx.log.warn(`plan: goal tasks could not be refreshed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return readGoals(ctx);
}

const inFlight = new Set<string>();

/** One scan. The caller holds the in-flight lock for `week`. */
async function planWeek(ctx: FeatureCtx, week: string, trigger: PlannedFor): Promise<PlanOutcome> {
  const s = ctx.settings();
  const existing = await ctx.store.get(KIND.plan, week, weekPlanSchema);
  // The user's own plan wins. Only an explicit request replaces a plan the agent made and nobody touched.
  const mayReplace = (p: WeekPlan | null): boolean => p === null || p.items.length === 0 || (trigger === "manual_trigger" && isReplaceable(p));
  if (!mayReplace(existing)) return "skipped";

  const goals = await ensureGoalTasks(ctx);
  const prevWeeks = previousWeeks(week, 4);
  const [framework, profile, ...history] = await Promise.all([
    ctx.framework(),
    ctx.store.get(KIND.profile, "active", profileSchema),
    ...prevWeeks.map((w) => ctx.store.get(KIND.plan, w, weekPlanSchema)),
  ]);
  const past = history.filter((p): p is WeekPlan => p !== null);
  const prev = history[history.length - 1] ?? null;
  const accuracy = planAccuracy(past);
  const scanGoals: ScanGoal[] = goals.goals.map((g) => ({ id: g.id, text: g.text, area: g.area, tasks: g.tasks.map((t) => ({ id: t.id, text: t.text, ref: t.ref, status: t.status })) }));

  const scan = await ctx.runner.runJob(
    planWeekJob({
      week,
      timeZone: s.timeZone,
      workdayHours: s.workdayHours,
      areas: framework.areas.map((a) => ({ key: a.key, label: a.label })),
      goals: scanGoals,
      lastWeek: lastWeekMarks(prev),
      calibration: accuracy.byWeek.length > 0 ? accuracy.note : null,
      ...(profile === null ? {} : { identity: { name: profile.identity.name, email: profile.identity.email, handles: profile.identity.handles } }),
    }),
    { model: s.captureModel || undefined, timeoutMs: s.captureTimeoutMinutes * 60_000, retryOnWorkerError: false },
  );

  // The user may have planned while the job ran: theirs wins.
  const latest = await ctx.store.get(KIND.plan, week, weekPlanSchema);
  if (!mayReplace(latest)) return "skipped";
  const base = latest !== null && latest.items.length > 0 ? emptyPlan(week) : (latest ?? emptyPlan(week));
  const now = ctx.now().toISOString();
  // Parse before writing: a reply that does not fit the schema fails the job here instead of making the stored week unreadable.
  const next = weekPlanSchema.parse({
    ...base,
    items: inferredItems(week, scan.commitments, prev, now),
    intent: scan.intent,
    shape: scan.shape,
    backlog: scan.backlog,
    plannedAt: now,
    plannedFor: trigger,
  });
  await ctx.store.set(KIND.plan, week, next);
  ctx.publish();
  return "planned";
}

/**
 * Plans `week` (default: this week Monday to Thursday, next week Friday to Sunday). Never throws and never overwrites a
 * plan the user made; one scan per week at a time. Safe to fire and forget.
 */
export async function planWeekNow(ctx: FeatureCtx, week: string | undefined, trigger: PlannedFor): Promise<PlanOutcome> {
  const target = week ?? weekToPlan(ctx.now(), ctx.settings().timeZone);
  if (inFlight.has(target)) return "busy";
  inFlight.add(target);
  try {
    return await planWeek(ctx, target, trigger);
  } catch (cause) {
    ctx.log.warn(`plan: could not plan ${target}: ${cause instanceof Error ? cause.message : String(cause)}`);
    return "failed";
  } finally {
    inFlight.delete(target);
  }
}

/**
 * The tick hook. At most one attempt per week: `plan_auto:<week>` is written BEFORE the run, and the in-flight guard is
 * taken synchronously, so overlapping ticks cannot start two runs. A plan that already has items is never touched.
 */
export async function autoPlanTick(ctx: FeatureCtx): Promise<void> {
  const s = ctx.settings();
  const now = ctx.now();
  const week = isoWeekOf(localToday(now, s.timeZone));
  if (inFlight.has(week) || !autoPlanDue(now, s.timeZone, week)) return;
  inFlight.add(week);
  try {
    if ((await ctx.store.getMeta(planAutoKey(week))) !== null) return;
    await ctx.store.setMeta(planAutoKey(week), now.toISOString());
    await planWeek(ctx, week, "auto");
  } finally {
    inFlight.delete(week);
  }
}

export function register(reg: Registry): void {
  reg.prompts.push(createPlanPrompt());
  reg.prompts.push(createRetroPrompt());
  reg.tickHooks.push({ id: "plan", onTick: autoPlanTick });
  reg.weekHooks.push({ id: "plan", afterWeekSaved: (week, ctx) => copyResults(week, ctx) });
  reg.grid.push({
    id: "plan",
    async contribute(grid, ctx) {
      const all = await ctx.store.list(KIND.plan, weekPlanSchema);
      if (all.some((r) => r.value.items.length > 0)) grid.lensAvailability.plan = true;
      const plans = new Map(all.map((r) => [r.id, r.value]));
      for (const gw of grid.weeks) {
        const plan = plans.get(gw.week);
        if (plan === undefined || plan.items.length === 0) continue;
        gw.markers.planHitRate = plan.hitRate;
        const week = await ctx.store.get(KIND.week, gw.week, workWeekSchema);
        const advanced = advancedByDate(plan.results, week?.evidence ?? []);
        for (const cell of gw.cells) cell.planAdvanced = advanced.get(cell.date) ?? 0;
      }
    },
  });
}
