/** service.ts — store-backed guardrails: rule storage (defaults on first read), context building, evaluation, results. */
import { z } from "zod";
import { addDays, isoWeekOf, localToday, weekDates } from "../../engine/dates";
import type { FeatureCtx } from "../../engine/extensions";
import { resolveArea } from "../../framework/rubric";
import { KIND, type Store } from "../../storage/port";
import {
  closureNoteSchema, guardrailResultSchema, guardrailRuleSchema, threadSchema, weekMixSchema, weekPlanSchema, workDaySchema, workWeekSchema,
  type GuardrailResult, type GuardrailRule, type WorkWeek,
} from "../../types";
import { snapshotAt } from "../drift/service";
import { acknowledge, reconcile } from "./lifecycle";
import { defaultRules, evaluateRules, windowWeeks, type RuleContext, type WeekFacts } from "./rules";

export const RULES_ID = "active";
/** Meta key: ISO time the user last saved the rules (the rules records carry no timestamp). Setup compares it with profile.setupAt. */
export const RULES_EDITED_META = "rules-edited-at";
const rulesSchema = z.array(guardrailRuleSchema);
// The threads feature stores {builtAt, todayWeek, threads, needClosure}; a bare array is accepted too.
const threadsSchema = z.union([z.array(threadSchema), z.object({ threads: z.array(threadSchema) }).transform((v) => v.threads)]);
export const THREADS_ID = "derived";

/** Largest look-back (in weeks) any enabled rule needs; at least 1. */
export function lookback(rules: readonly GuardrailRule[]): number {
  let n = 1;
  for (const { enabled, rule } of rules) if (enabled && "weeks" in rule && rule.type !== "closure_rate") n = Math.max(n, rule.weeks);
  return Math.min(n, 12);
}

/** Stored rules; the defaults are written on the first read. */
export async function loadRules(ctx: FeatureCtx): Promise<GuardrailRule[]> {
  const stored = await ctx.store.get(KIND.rules, RULES_ID, rulesSchema);
  if (stored !== null) return stored;
  const framework = await ctx.framework();
  const rules = defaultRules(framework.areas.filter((a) => a.kind === "hands_on").map((a) => a.key));
  await ctx.store.set(KIND.rules, RULES_ID, rules);
  return rules;
}

export const validateRules = (rules: readonly GuardrailRule[]): void => {
  const seen = new Set<string>();
  for (const r of rules) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(r.id)) throw new Error(`Rule id "${r.id}" may only contain letters, digits, "_" and "-".`);
    if (seen.has(r.id)) throw new Error(`Duplicate rule id "${r.id}".`);
    seen.add(r.id);
  }
};

export async function buildContext(ctx: FeatureCtx, week: string, rules: readonly GuardrailRule[]): Promise<RuleContext> {
  const framework = await ctx.framework();
  const ids = windowWeeks({ week } as RuleContext, lookback(rules));
  const first = ids[0]!;
  const dates = weekDates(week);
  const [records, mixes, plans, days, laterWeeks, threads, closures, snapshot] = await Promise.all([
    ctx.store.list(KIND.week, workWeekSchema, { from: first, to: week }),
    ctx.store.list(KIND.mix, weekMixSchema, { from: first, to: week }),
    ctx.store.list(KIND.plan, weekPlanSchema, { from: first, to: week }),
    ctx.store.list(KIND.day, workDaySchema, { from: dates[0], to: addDays(dates[0]!, 6) }),
    ctx.store.list(KIND.week, workWeekSchema, { from: week, limit: 2 }),
    ctx.store.get(KIND.threads, THREADS_ID, threadsSchema),
    ctx.store.list(KIND.closure, closureNoteSchema),
    snapshotAt(ctx.store, week, ctx.now()),
  ]);
  const facts: Record<string, WeekFacts> = {};
  for (const w of ids) facts[w] = { week: w, record: null, mix: null, plan: null, coverageDays: [] };
  for (const r of records) facts[r.id]!.record = r.value;
  for (const r of mixes) facts[r.id]!.mix = r.value;
  for (const r of plans) facts[r.id]!.plan = r.value;
  facts[week]!.coverageDays = days.map((d) => ({ date: d.value.date, coverage: d.value.coverage }));
  return {
    week,
    facts,
    snapshot,
    threads,
    closures: closures.map((c) => c.value),
    isLatest: laterWeeks.every((r) => r.id <= week),
    areaLabels: Object.fromEntries(framework.areas.map((a) => [a.key, a.label])),
    resolveArea: (key) => resolveArea(framework, key),
  };
}

export const loadResults = async (store: Store): Promise<GuardrailResult[]> => (await store.list(KIND.violation, guardrailResultSchema)).map((r) => r.value);

/** Evaluate every enabled rule for `week` and write the violation records. Returns the records that changed. */
export async function evaluateWeek(ctx: FeatureCtx, week: string): Promise<GuardrailResult[]> {
  const rules = await loadRules(ctx);
  const context = await buildContext(ctx, week, rules);
  const evaluations = evaluateRules(rules, context);
  const changed = reconcile(await loadResults(ctx.store), evaluations, rules, week, ctx.now().toISOString());
  for (const r of changed) await ctx.store.set(KIND.violation, r.id, r);
  if (changed.length > 0) ctx.publish();
  return changed;
}

export async function acknowledgeResult(ctx: FeatureCtx, id: string, note: string): Promise<void> {
  const changed = acknowledge(await loadResults(ctx.store), id, note, ctx.now().toISOString());
  if (changed === null) throw new Error(`No guardrail result "${id}".`);
  for (const r of changed) await ctx.store.set(KIND.violation, r.id, r);
  ctx.publish();
}

/** Re-evaluate the newest weeks (oldest first) after the rules change. */
export async function reevaluateRecent(ctx: FeatureCtx, count = 4): Promise<void> {
  const rows = await ctx.store.list(KIND.week, workWeekSchema);
  for (const row of rows.slice(-count)) await evaluateWeek(ctx, row.id);
}

export const currentWeekOf = (ctx: FeatureCtx): string => isoWeekOf(localToday(ctx.now(), ctx.settings().timeZone));

export type { WorkWeek };
