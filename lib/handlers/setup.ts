/** handlers/setup.ts — setup.* (zero-config setup) and goals.*. */
import { readGoals, readProfile, readState, reapply, saveProfile, startSynthesis, type SetupDeps } from "../features/setup/service";
import { isSafeGoalId } from "../features/goals/progress";
import { refreshGoalTasks, sanitizeTasks, tombstones } from "../features/goals/tasks";
import { areaKeys } from "../framework/rubric";
import { KIND } from "../storage/port";
import type { Goal } from "../types";
import type { HandlersFn } from "./types";

type Methods = "setup.get" | "setup.answer" | "setup.synthesize" | "setup.apply" | "goals.get" | "goals.set" | "goals.refresh";

export const handlers: HandlersFn<Methods> = (ctx, service, env) => {
  const deps: SetupDeps = { ctx, run: (input) => service.run(input), enableSchedule: env.enableSchedule };
  return {
    "setup.get": async () => {
      const [profile, state] = await Promise.all([readProfile(ctx), readState(ctx)]);
      return { profile, proposal: state?.proposal ?? null, status: state?.status ?? "idle", error: state?.error ?? null, kept: state?.kept ?? [] };
    },
    "setup.answer": async ({ profile }) => {
      await saveProfile(ctx, profile);
      return { ok: true as const };
    },
    "setup.synthesize": async () => {
      await startSynthesis(deps);
      return { ok: true as const };
    },
    "setup.apply": async () => {
      await reapply(deps);
      return { ok: true as const };
    },
    "goals.get": () => readGoals(ctx),
    "goals.set": async ({ goals }) => {
      const keys = new Set(areaKeys(await ctx.framework()));
      const stored = await readGoals(ctx);
      const before = new Map(stored.goals.map((g) => [g.id, g]));
      const stamp = ctx.now().toISOString();
      const used = new Set<string>();
      const clean: Goal[] = [];
      for (const g of goals) {
        const text = g.text.trim();
        if (text === "") continue;
        // Ids go into prompts: keep them to letters, digits, "_" and "-" (max 64); anything else gets a fresh id.
        const fresh = () => `goal-${ctx.now().getTime().toString(36)}-${clean.length + 1}`;
        let id = g.id.trim();
        if (!isSafeGoalId(id)) id = fresh();
        for (let n = 2; used.has(id); n++) id = isSafeGoalId(`${id}x`) ? `${id}x` : `${fresh()}-${n}`;
        used.add(id);
        const old = before.get(g.id);
        const same = old !== undefined && old.text === text;
        // Tasks follow the goal under its stored id; a renamed goal starts with the tasks it was sent with.
        const kept = id === g.id.trim() && old !== undefined ? old : undefined;
        const tasks = sanitizeTasks(g.tasks ?? [], kept?.tasks ?? []);
        // Tombstones are the server's: a dropped task survives being capped away.
        const droppedRefs = tombstones(kept?.droppedRefs ?? [], [...(kept?.tasks ?? []).filter((t) => !(g.tasks ?? []).some((x) => x.id === t.id)), ...(g.tasks ?? [])]);
        clean.push({ id, text, area: g.area !== null && keys.has(g.area) ? g.area : null, source: same ? old.source : "user", basis: same ? old.basis : null, createdAt: g.createdAt || stamp, tasks, droppedRefs });
      }
      const next = { version: 1 as const, goals: clean, tasksRefreshedAt: stored.tasksRefreshedAt };
      await ctx.store.set(KIND.goals, "active", next);
      ctx.publish();
      return next;
    },
    // Runs in the background; a failure is logged and leaves the goals as they were.
    "goals.refresh": () => {
      void refreshGoalTasks(ctx);
      return { ok: true as const };
    },
  };
};
