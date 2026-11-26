/**
 * service.ts — the role framework store and the allocation targets store. Pure validation first (`validateFramework`,
 * `validateTargets`), then a thin service over `KIND.framework` "active" and `KIND.targets` "active".
 */
import type { FeatureCtx } from "../engine/extensions";
import { KIND } from "../storage/port";
import { allocationTargetsSchema, roleFrameworkSchema, type AllocationTargets, type RoleFramework } from "../types";
import { DEFAULT_FRAMEWORK, PRESET_FRAMEWORKS } from "./default";
import { areaKeys } from "./rubric";

const issueText = (cause: unknown): string => {
  const issues = (cause as { issues?: Array<{ path: Array<string | number>; message: string }> }).issues;
  if (Array.isArray(issues)) return issues.map((i) => `${i.path.join(".") || "framework"}: ${i.message}`).join("; ");
  return cause instanceof Error ? cause.message : String(cause);
};

/**
 * Aliases after `next` replaces `prev`: a key renamed in place (same position, old key gone, new key new) becomes
 * `old -> new`; earlier aliases are re-pointed at the newest key; aliases that shadow a current key or point nowhere are dropped.
 */
export function nextAliases(prev: RoleFramework, next: RoleFramework): Record<string, string> {
  const nextKeys = new Set(areaKeys(next));
  const prevKeys = new Set(areaKeys(prev));
  const renames: Record<string, string> = {};
  prev.areas.forEach((old, i) => {
    const now = next.areas[i];
    if (now !== undefined && now.key !== old.key && !nextKeys.has(old.key) && !prevKeys.has(now.key)) renames[old.key] = now.key;
  });
  const merged: Record<string, string> = { ...prev.areaAliases, ...next.areaAliases };
  for (const [from, to] of Object.entries(renames)) {
    for (const key of Object.keys(merged)) if (merged[key] === from) merged[key] = to;
    merged[from] = to;
  }
  const out: Record<string, string> = {};
  for (const [from, to] of Object.entries(merged)) if (!nextKeys.has(from) && nextKeys.has(to)) out[from] = to;
  return out;
}

/** Validates a framework edit against the active one and returns the framework to store. Throws a plain Error. */
export function validateFramework(input: unknown, prev: RoleFramework, now: Date): RoleFramework {
  const parsed = roleFrameworkSchema.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid framework: ${issueText(parsed.error)}`);
  const next = parsed.data;
  const seen = new Set<string>();
  for (const area of next.areas) {
    if (seen.has(area.key)) throw new Error(`Duplicate area key: ${area.key}`);
    seen.add(area.key);
  }
  return { ...next, areaAliases: nextAliases(prev, next), updatedAt: now.toISOString() };
}

/** Targets must name only the framework's areas and sum to 100 (+-1). Returns the targets to store. */
export function validateTargets(input: AllocationTargets, framework: RoleFramework, now: Date): AllocationTargets {
  const keys = new Set(areaKeys(framework));
  const unknown = Object.keys(input.targets).filter((k) => !keys.has(k));
  if (unknown.length > 0) throw new Error(`Targets name areas that are not in the framework: ${unknown.join(", ")}`);
  const sum = Object.values(input.targets).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 100) > 1) throw new Error(`Targets must sum to 100 (+-1); they sum to ${Math.round(sum * 10) / 10}`);
  return allocationTargetsSchema.parse({ ...input, frameworkId: framework.id, updatedAt: now.toISOString() });
}

/** A preset applied over the active framework: the preset's areas and rubric; the user's name, pronoun and manager stay. */
export function applyPreset(preset: RoleFramework, active: RoleFramework, now: Date): RoleFramework {
  const next: RoleFramework = { ...preset, subject: active.subject, managerName: active.managerName, areaAliases: {}, updatedAt: now.toISOString() };
  return { ...next, areaAliases: nextAliases(active, next) };
}

export const listPresets = (): Array<{ id: string; name: string }> => PRESET_FRAMEWORKS.map((p) => ({ id: p.id, name: p.name }));

export function createFrameworkService(ctx: Pick<FeatureCtx, "store" | "framework" | "publish" | "now">) {
  const { store } = ctx;
  const save = async (framework: RoleFramework): Promise<RoleFramework> => {
    await store.set(KIND.framework, "active", framework);
    ctx.publish();
    return framework;
  };
  return {
    async get() {
      return { framework: (await store.get(KIND.framework, "active", roleFrameworkSchema)) ?? DEFAULT_FRAMEWORK, presets: listPresets() };
    },
    async set(input: unknown) {
      return save(validateFramework(input, await ctx.framework(), ctx.now()));
    },
    async usePreset(id: string) {
      const preset = PRESET_FRAMEWORKS.find((p) => p.id === id);
      if (preset === undefined) throw new Error(`Unknown preset: ${id}`);
      return save(applyPreset(preset, await ctx.framework(), ctx.now()));
    },
    getTargets: () => store.get(KIND.targets, "active", allocationTargetsSchema),
    async setTargets(input: AllocationTargets) {
      const next = validateTargets(input, await ctx.framework(), ctx.now());
      await store.set(KIND.targets, "active", next);
      ctx.publish();
      return next;
    },
  };
}
export type FrameworkService = ReturnType<typeof createFrameworkService>;
