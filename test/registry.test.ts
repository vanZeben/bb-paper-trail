import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createRegistry, FEATURE_ORDER, type Registry } from "../lib/engine/extensions";
import { register as registerConnectors } from "../lib/features/connectors";
import { register as registerDrift } from "../lib/features/drift";
import { register as registerFramework } from "../lib/features/framework";
import { register as registerGhost } from "../lib/features/ghost";
import { register as registerGoals } from "../lib/features/goals";
import { register as registerGuardrails } from "../lib/features/guardrails";
import { register as registerMigrate } from "../lib/features/migrate";
import { register as registerOverrides } from "../lib/features/overrides";
import { register as registerPacket } from "../lib/features/packet";
import { register as registerPlan } from "../lib/features/plan";
import { register as registerThreads } from "../lib/features/threads";

const FEATURES: Record<(typeof FEATURE_ORDER)[number], (reg: Registry) => void> = {
  connectors: registerConnectors, framework: registerFramework, overrides: registerOverrides, goals: registerGoals, plan: registerPlan,
  drift: registerDrift, threads: registerThreads, guardrails: registerGuardrails, ghost: registerGhost, packet: registerPacket, migrate: registerMigrate,
};

describe("feature registry", () => {
  const reg = createRegistry();
  for (const id of FEATURE_ORDER) FEATURES[id](reg);

  it("registers prompt extensions in feature order: goals before plan, and the retro after the plan", () => {
    const ids = reg.prompts.map((p) => p.id);
    expect(ids).toContain("goals");
    expect(ids).toContain("goal-tasks");
    expect(ids).toContain("plan");
    expect(ids).toContain("planRetro");
    expect(ids.indexOf("goals")).toBeLessThan(ids.indexOf("plan"));
    expect(ids.indexOf("plan")).toBeLessThan(ids.indexOf("planRetro"));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("registers the week hooks and the tick hook", () => {
    const weekIds = reg.weekHooks.map((h) => h.id);
    expect(weekIds).toContain("goal-tasks");
    expect(weekIds).toContain("plan");
    expect(weekIds.indexOf("goal-tasks")).toBeLessThan(weekIds.indexOf("plan"));
    expect(reg.tickHooks.map((h) => h.id)).toEqual(["plan"]);
    expect(reg.grid.map((g) => g.id)).toContain("plan");
  });

  it("FEATURE_ORDER puts goals before plan, and server.ts registers every feature in it", () => {
    expect(FEATURE_ORDER.indexOf("goals")).toBeGreaterThanOrEqual(0);
    expect(FEATURE_ORDER.indexOf("goals")).toBeLessThan(FEATURE_ORDER.indexOf("plan"));
    const server = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    expect(server).toMatch(/goals: registerGoals,/);
    expect(server).toMatch(/plan: registerPlan,/);
    expect(server).toMatch(/for \(const id of FEATURE_ORDER\) FEATURES\[id\]\(registry\)/);
  });
});
