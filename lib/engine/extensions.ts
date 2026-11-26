/**
 * extensions.ts — the extension points that let feature modules (lib/features/<f>/) add behaviour without
 * editing shared engine files. Each feature exports `register(reg: Registry): void` from lib/features/<f>/index.ts;
 * server.ts calls them in FEATURE_ORDER.
 *
 * - PromptExtension: extra rules for the day rating / week judgment, and validation of extra keys in the judgment
 *   reply (stored at week.ext[id]). Used by overrides (calibration examples) and plan (plan results).
 * - TickHook: runs on every scheduled tick, never awaited (the plan feature uses it to auto-plan the week).
 * - WeekHook / DayHook: run after a week is saved / a day is rated. A failing hook is logged and never fails the run.
 *   Used by drift, guardrails, threads, ghost, overrides.
 * - GridContributor: fills lens and marker fields on the grid payload in place (grid.get). Used by overrides
 *   (effective rating), drift, guardrails, plan, threads.
 */
import type { GridV2, RoleFramework, WorkDay, WorkWeek } from "../types";
import type { Settings } from "../settings";
import type { Store } from "../storage/port";
import type { Log, Runner } from "./runner";

/** What every feature hook and handler gets. Built once in server.ts. */
export interface FeatureCtx {
  store: Store;
  settings: () => Settings;
  /** The active role framework (default framework when none is stored). */
  framework: () => Promise<RoleFramework>;
  runner: Runner;
  log: Log;
  /** Publish on the realtime channel so the app re-reads. */
  publish: () => void;
  now: () => Date;
}

export interface PromptCtx {
  /** ISO week being judged (for day rules: the day's week). */
  week: string;
  dates: string[];
  framework: RoleFramework;
  settings: Settings;
  store: Store;
}

export interface PromptExtension {
  id: string;
  /** Extra lines appended to the day-rating rules. */
  dayRules?(ctx: PromptCtx & { date: string }): Promise<string> | string;
  /** Extra lines appended to the week-judgment rules (e.g. calibration examples, the week's plan items). */
  weekRules?(ctx: PromptCtx): Promise<string> | string;
  /** Extra top-level keys for the judgment's reply example, as a JSON fragment such as `"plan":[{"itemId":"…"}]`. */
  weekReplyExample?(ctx: PromptCtx): Promise<string> | string;
  /**
   * Validates this extension's keys in the raw judgment reply; the result is stored at week.ext[id].
   * Throw to reject the whole reply (the runner then retries once).
   */
  validateWeekExtra?(raw: Record<string, unknown>, ctx: PromptCtx): unknown;
}

export interface WeekHook {
  id: string;
  afterWeekSaved(week: WorkWeek, ctx: FeatureCtx): Promise<void>;
}

export interface DayHook {
  id: string;
  afterDayRated(day: WorkDay, ctx: FeatureCtx): Promise<void>;
}

/** Runs from the scheduled tick (every few minutes), after the capture slots. Must be cheap when there is nothing to do. */
export interface TickHook {
  id: string;
  onTick(ctx: FeatureCtx): Promise<void>;
}

export interface GridContributor {
  id: string;
  /** Mutates `grid` in place: cell lens fields, week markers, lensAvailability. */
  contribute(grid: GridV2, ctx: FeatureCtx): Promise<void>;
}

export interface Registry {
  prompts: PromptExtension[];
  weekHooks: WeekHook[];
  dayHooks: DayHook[];
  grid: GridContributor[];
  tickHooks: TickHook[];
}

export const createRegistry = (): Registry => ({ prompts: [], weekHooks: [], dayHooks: [], grid: [], tickHooks: [] });

/** Feature modules, in the order their hooks and contributors run. */
export const FEATURE_ORDER = ["connectors", "framework", "overrides", "goals", "plan", "drift", "threads", "guardrails", "ghost", "packet", "migrate"] as const;
export type FeatureId = (typeof FEATURE_ORDER)[number];

export interface PromptExtras {
  rules: string;
  replyExample: string;
}

const joinParts = (parts: string[]) => parts.map((p) => p.trim()).filter(Boolean).join("\n");

export async function dayPromptExtras(reg: Registry, ctx: PromptCtx & { date: string }): Promise<string> {
  const parts: string[] = [];
  for (const p of reg.prompts) if (p.dayRules) parts.push(await p.dayRules(ctx));
  return joinParts(parts);
}

export async function weekPromptExtras(reg: Registry, ctx: PromptCtx): Promise<PromptExtras> {
  const rules: string[] = [];
  const examples: string[] = [];
  for (const p of reg.prompts) {
    if (p.weekRules) rules.push(await p.weekRules(ctx));
    if (p.weekReplyExample) examples.push(await p.weekReplyExample(ctx));
  }
  return { rules: joinParts(rules), replyExample: examples.map((e) => e.trim()).filter(Boolean).join(",") };
}

/** Throws when any extension rejects the reply. */
export function validateWeekExtras(reg: Registry, raw: Record<string, unknown>, ctx: PromptCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of reg.prompts) if (p.validateWeekExtra) out[p.id] = p.validateWeekExtra(raw, ctx);
  return out;
}

export async function runWeekHooks(reg: Registry, week: WorkWeek, ctx: FeatureCtx): Promise<void> {
  for (const h of reg.weekHooks) {
    try {
      await h.afterWeekSaved(week, ctx);
    } catch (cause) {
      ctx.log.warn(`week hook ${h.id} failed for ${week.week}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
}

export async function runDayHooks(reg: Registry, day: WorkDay, ctx: FeatureCtx): Promise<void> {
  for (const h of reg.dayHooks) {
    try {
      await h.afterDayRated(day, ctx);
    } catch (cause) {
      ctx.log.warn(`day hook ${h.id} failed for ${day.date}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
}

/**
 * Fire-and-forget: each hook runs on its own, a slow one (a model job) never delays the tick or another hook, and a
 * failure is logged. Returns the promises so tests can await them; production callers ignore the result.
 */
export function runTickHooks(reg: Registry, ctx: FeatureCtx): Promise<void>[] {
  return reg.tickHooks.map((h) =>
    Promise.resolve()
      .then(() => h.onTick(ctx))
      .catch((cause: unknown) => ctx.log.warn(`tick hook ${h.id} failed: ${cause instanceof Error ? cause.message : String(cause)}`)),
  );
}

export async function runGridContributors(reg: Registry, grid: GridV2, ctx: FeatureCtx): Promise<void> {
  for (const c of reg.grid) {
    try {
      await c.contribute(grid, ctx);
    } catch (cause) {
      ctx.log.warn(`grid contributor ${c.id} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
}
