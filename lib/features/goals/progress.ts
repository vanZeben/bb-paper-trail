/**
 * progress.ts — the goal-progress PromptExtension (stored at week.ext.goals, unchanged shape) and the goal-task update
 * extension: the same judge reply also lists which tasks moved (taskUpdates, stored at week.ext["goal-tasks"]); a WeekHook applies them.
 */
import type { FeatureCtx, PromptCtx, PromptExtension, WeekHook } from "../../engine/extensions";
import { fencedData, promptText } from "../../engine/evidence";
import { KIND } from "../../storage/port";
import { goalsSchema, workDaySchema, type Goal, type GoalTask, type WorkWeek } from "../../types";

export interface GoalProgress {
  goalId: string;
  status: "advanced" | "no_movement";
  evidenceIds: string[];
}
export const GOAL_REPLY_EXAMPLE = `"goalProgress":[{"goalId":"…","status":"advanced|no_movement","evidenceIds":["…"]}]`;

const GOAL_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const isSafeGoalId = (id: string): boolean => GOAL_ID.test(id);

/**
 * The ids the judge sees: stored ids that are already plain pass through; anything else (older data, imports) is cleaned
 * to letters, digits, "_" and "-", or replaced by `goal-N`, and made unique. Maps the prompt id back to the stored id.
 */
export function promptGoalIds(goals: ReadonlyArray<{ id: string }>): Map<string, string> {
  const out = new Map<string, string>();
  goals.forEach((g, i) => {
    let id = isSafeGoalId(g.id) ? g.id : g.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60);
    if (id === "") id = `goal-${i + 1}`;
    for (let n = 2; out.has(id); n++) id = `${id.slice(0, 58)}-${n}`;
    out.set(id, g.id);
  });
  return out;
}

export function goalRules(goals: ReadonlyArray<{ id: string; text: string }>): string {
  if (goals.length === 0) return "";
  const ids = promptGoalIds(goals);
  const shown = [...ids.keys()];
  return [
    "STANDING GOALS for this half. In goalProgress give one entry per goal id: did this week ADVANCE it, judged from the evidence only?",
    ...goals.map((g, i) => `- [${shown[i]}] ${promptText(g.text, 200)}`),
    `"advanced" = real movement and you MUST cite at least one evidence id; "no_movement" = nothing in the evidence. Use only the goal ids above and evidence ids from the evidence block.`,
  ].join("\n");
}

/** Unknown goals and evidence ids are dropped, repeats keep the first, "advanced" without evidence becomes "no_movement". */
export function validateGoalProgress(raw: Record<string, unknown>, ctx: { goalIds: ReadonlySet<string>; evidenceIds: ReadonlySet<string>; storedIds?: ReadonlyMap<string, string> }): GoalProgress[] {
  const list = raw.goalProgress;
  if (!Array.isArray(list)) return [];
  const out: GoalProgress[] = [];
  const seen = new Set<string>();
  for (const e of list) {
    if (typeof e !== "object" || e === null) continue;
    const r = e as Record<string, unknown>;
    const goalId = typeof r.goalId === "string" ? r.goalId : "";
    if (!ctx.goalIds.has(goalId) || seen.has(goalId) || (r.status !== "advanced" && r.status !== "no_movement")) continue;
    seen.add(goalId);
    const ids = Array.isArray(r.evidenceIds) ? [...new Set(r.evidenceIds.filter((x): x is string => typeof x === "string" && ctx.evidenceIds.has(x)))] : [];
    out.push({ goalId: ctx.storedIds?.get(goalId) ?? goalId, status: r.status === "advanced" && ids.length === 0 ? "no_movement" : r.status, evidenceIds: ids });
  }
  return out;
}

export function createGoalsPrompt(): PromptExtension {
  const byCtx = new WeakMap<PromptCtx, { goalIds: Set<string>; evidenceIds: Set<string>; storedIds: Map<string, string> }>();
  const byWeek = new Map<string, { goalIds: Set<string>; evidenceIds: Set<string>; storedIds: Map<string, string> }>();
  return {
    id: "goals",
    async weekRules(ctx) {
      const goals = (await ctx.store.get(KIND.goals, "active", goalsSchema))?.goals ?? [];
      const days = await Promise.all(ctx.dates.map((d) => ctx.store.get(KIND.day, d, workDaySchema)));
      const storedIds = promptGoalIds(goals);
      const state = { goalIds: new Set(storedIds.keys()), storedIds, evidenceIds: new Set(days.flatMap((d) => (d === null ? [] : d.evidence.map((e) => e.id)))) };
      byCtx.set(ctx, state);
      byWeek.set(ctx.week, state);
      return goalRules(goals);
    },
    weekReplyExample(ctx) {
      const state = byCtx.get(ctx) ?? byWeek.get(ctx.week);
      return state !== undefined && state.goalIds.size > 0 ? GOAL_REPLY_EXAMPLE : "";
    },
    validateWeekExtra(raw, ctx) {
      const state = byCtx.get(ctx) ?? byWeek.get(ctx.week) ?? { goalIds: new Set<string>(), evidenceIds: new Set<string>(), storedIds: new Map<string, string>() };
      return validateGoalProgress(raw, state);
    },
  };
}

// ─── goal-task updates ───────────────────────────────────────────────────────

/** The id the task updates are stored under in week.ext. */
export const TASK_EXT_ID = "goal-tasks";
export interface TaskUpdate {
  taskId: string;
  status: "in_progress" | "done";
  evidenceIds: string[];
}
export const TASK_REPLY_EXAMPLE = `"taskUpdates":[{"taskId":"…","status":"in_progress|done","evidenceIds":["…"]}]`;

/** Tasks the judge may report on: still unfinished. */
const unfinished = (t: GoalTask): boolean => t.status === "open" || t.status === "in_progress";

export function taskRules(goals: ReadonlyArray<Pick<Goal, "id" | "text" | "tasks">>): string {
  const rows: string[] = [];
  for (const g of goals) for (const t of g.tasks ?? []) if (unfinished(t)) rows.push(`[${t.id}] (${t.status}) ${promptText(t.text, 200)}`);
  if (rows.length === 0) return "";
  return [
    "GOAL TASKS still open. In taskUpdates list ONLY the tasks the evidence shows moved this week: \"done\" when the evidence shows it was finished, \"in_progress\" when it was worked on but not finished. Each entry MUST cite at least one evidence id; leave out tasks with no movement.",
    fencedData(rows.join("\n"), "TASKS"),
    "Use only the task ids above and evidence ids from the evidence block.",
  ].join("\n");
}

/** Unknown task ids and evidence ids are dropped, repeats keep the first, entries without usable evidence are dropped. */
export function validateTaskUpdates(raw: Record<string, unknown>, ctx: { taskIds: ReadonlySet<string>; evidenceIds: ReadonlySet<string> }): TaskUpdate[] {
  const list = raw.taskUpdates;
  if (!Array.isArray(list)) return [];
  const out: TaskUpdate[] = [];
  const seen = new Set<string>();
  for (const e of list) {
    if (typeof e !== "object" || e === null) continue;
    const r = e as Record<string, unknown>;
    const taskId = typeof r.taskId === "string" ? r.taskId : "";
    if (!ctx.taskIds.has(taskId) || seen.has(taskId) || (r.status !== "in_progress" && r.status !== "done")) continue;
    const ids = Array.isArray(r.evidenceIds) ? [...new Set(r.evidenceIds.filter((x): x is string => typeof x === "string" && ctx.evidenceIds.has(x)))] : [];
    if (ids.length === 0) continue;
    seen.add(taskId);
    out.push({ taskId, status: r.status, evidenceIds: ids });
  }
  return out;
}

export function createTaskUpdatesPrompt(): PromptExtension {
  interface State {
    taskIds: Set<string>;
    evidenceIds: Set<string>;
  }
  const byCtx = new WeakMap<PromptCtx, State>();
  const byWeek = new Map<string, State>();
  return {
    id: TASK_EXT_ID,
    async weekRules(ctx) {
      const goals = (await ctx.store.get(KIND.goals, "active", goalsSchema))?.goals ?? [];
      const days = await Promise.all(ctx.dates.map((d) => ctx.store.get(KIND.day, d, workDaySchema)));
      const state: State = {
        taskIds: new Set(goals.flatMap((g) => g.tasks.filter(unfinished).map((t) => t.id))),
        evidenceIds: new Set(days.flatMap((d) => (d === null ? [] : d.evidence.map((e) => e.id)))),
      };
      byCtx.set(ctx, state);
      byWeek.set(ctx.week, state);
      return taskRules(goals);
    },
    weekReplyExample(ctx) {
      const state = byCtx.get(ctx) ?? byWeek.get(ctx.week);
      return state !== undefined && state.taskIds.size > 0 ? TASK_REPLY_EXAMPLE : "";
    },
    validateWeekExtra(raw, ctx) {
      const state = byCtx.get(ctx) ?? byWeek.get(ctx.week) ?? { taskIds: new Set<string>(), evidenceIds: new Set<string>() };
      return validateTaskUpdates(raw, state);
    },
  };
}

const MAX_TASK_EVIDENCE = 12;
const RANK: Record<GoalTask["status"], number> = { open: 0, in_progress: 1, done: 2, dropped: 3 };

/**
 * Applies one judged week's updates to the stored tasks. Status only moves forward (open -> in_progress -> done), a
 * dropped task stays dropped, and a task the user wrote can only be marked done. Returns the new goals, or null when
 * nothing changed.
 */
export function applyTaskUpdates(goals: readonly Goal[], updates: readonly TaskUpdate[], week: string): Goal[] | null {
  let changed = false;
  const byId = new Map(updates.map((u) => [u.taskId, u]));
  const next = goals.map((g) => ({
    ...g,
    tasks: g.tasks.map((t) => {
      const u = byId.get(t.id);
      if (u === undefined || t.status === "dropped" || t.status === "done" || RANK[u.status] <= RANK[t.status]) return t;
      if (t.source === "user" && u.status !== "done") return t;
      if (t.updatedWeek !== null && t.updatedWeek > week) return t;
      changed = true;
      return { ...t, status: u.status, updatedWeek: week, evidenceIds: [...new Set([...t.evidenceIds, ...u.evidenceIds])].slice(-MAX_TASK_EVIDENCE) };
    }),
  }));
  return changed ? next : null;
}

export async function taskUpdatesHook(week: WorkWeek, ctx: FeatureCtx): Promise<void> {
  const raw = week.ext[TASK_EXT_ID];
  const updates = (Array.isArray(raw) ? raw : []).filter(
    (u): u is TaskUpdate => typeof u === "object" && u !== null && typeof (u as TaskUpdate).taskId === "string" && ((u as TaskUpdate).status === "in_progress" || (u as TaskUpdate).status === "done") && Array.isArray((u as TaskUpdate).evidenceIds),
  );
  if (updates.length === 0) return;
  const record = await ctx.store.get(KIND.goals, "active", goalsSchema);
  if (record === null) return;
  const next = applyTaskUpdates(record.goals, updates, week.week);
  if (next === null) return;
  await ctx.store.set(KIND.goals, "active", { ...record, goals: next });
  ctx.publish();
}

export const taskUpdatesWeekHook: WeekHook = { id: TASK_EXT_ID, afterWeekSaved: taskUpdatesHook };
