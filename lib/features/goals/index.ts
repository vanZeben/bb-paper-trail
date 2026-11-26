/**
 * goals — standing goals broken into tasks and kept current.
 * Records: `goals`/`active` (goalsSchema: goals with tasks, tasksRefreshedAt). `refreshGoalTasks` (tasks.ts) maps the
 * backlog onto the goals; the week judge's goalProgress (week.ext.goals) and taskUpdates (week.ext["goal-tasks"]) come from
 * the two prompt extensions in progress.ts, and a week hook applies the task updates.
 */
import type { Registry } from "../../engine/extensions";
import { createGoalsPrompt, createTaskUpdatesPrompt, taskUpdatesWeekHook } from "./progress";

export { refreshGoalTasks, tasksStale } from "./tasks";

export function register(reg: Registry): void {
  reg.prompts.push(createGoalsPrompt());
  reg.prompts.push(createTaskUpdatesPrompt());
  reg.weekHooks.push(taskUpdatesWeekHook);
}
