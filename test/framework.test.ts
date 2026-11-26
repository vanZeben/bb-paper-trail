import { describe, expect, it } from "vitest";
import type { FeatureCtx } from "../lib/engine/extensions";
import type { Job, Runner } from "../lib/engine/runner";
import { startImport } from "../lib/features/framework/import";
import { DEFAULT_FRAMEWORK, PRESET_FRAMEWORKS } from "../lib/framework/default";
import { importDocJob, readProposal, validateProposal } from "../lib/framework/import-doc";
import { resolveArea } from "../lib/framework/rubric";
import { createFrameworkService, nextAliases, validateFramework, validateTargets } from "../lib/framework/service";
import { DEFAULT_SETTINGS } from "../lib/settings";
import { createMemoryStore } from "../lib/storage/memory";
import { KIND } from "../lib/storage/port";
import type { AllocationTargets, RoleFramework } from "../lib/types";

const NOW = new Date("2026-11-20T12:00:00Z");
const areas = (keys: string[]) => keys.map((key) => ({ key, label: key.toUpperCase(), description: `${key} work`, kind: "other" as const }));
const withAreas = (keys: string[], extra: Partial<RoleFramework> = {}): RoleFramework => ({ ...DEFAULT_FRAMEWORK, areas: areas(keys), ...extra });

describe("validateFramework", () => {
  it("accepts a valid edit and stamps updatedAt", () => {
    const next = validateFramework(withAreas(["a1", "b1"]), DEFAULT_FRAMEWORK, NOW);
    expect(next.updatedAt).toBe(NOW.toISOString());
  });

  it("rejects duplicate keys, bad keys and area counts outside 2-10", () => {
    expect(() => validateFramework(withAreas(["delivery", "delivery"]), DEFAULT_FRAMEWORK, NOW)).toThrow(/Duplicate area key: delivery/);
    expect(() => validateFramework(withAreas(["Bad Key", "ok_key"]), DEFAULT_FRAMEWORK, NOW)).toThrow(/Invalid framework/);
    expect(() => validateFramework(withAreas(["only_one"]), DEFAULT_FRAMEWORK, NOW)).toThrow(/Invalid framework/);
    expect(() => validateFramework(withAreas(Array.from({ length: 11 }, (_, i) => `area_${i}`)), DEFAULT_FRAMEWORK, NOW)).toThrow(/Invalid framework/);
    expect(validateFramework(withAreas(Array.from({ length: 10 }, (_, i) => `area_${i}`)), DEFAULT_FRAMEWORK, NOW).areas).toHaveLength(10);
  });

  it("writes areaAliases when a key is renamed in place, and old keys still resolve", () => {
    const renamed = withAreas(DEFAULT_FRAMEWORK.areas.map((a) => (a.key === "direction" ? "strategy" : a.key)));
    const next = validateFramework(renamed, DEFAULT_FRAMEWORK, NOW);
    expect(next.areaAliases).toEqual({ direction: "strategy" });
    expect(resolveArea(next, "direction")).toBe("strategy");
    expect(resolveArea(next, "delivery")).toBe("delivery");
  });

  it("re-points chained renames and drops aliases that shadow a live key or point nowhere", () => {
    const first = validateFramework(withAreas(["alpha", "beta"]), withAreas(["alfa", "beta"]), NOW);
    expect(first.areaAliases).toEqual({ alfa: "alpha" });
    const second = validateFramework(withAreas(["omega", "beta"]), first, NOW);
    expect(second.areaAliases).toEqual({ alfa: "omega", alpha: "omega" });
    // alias target removed -> alias dropped
    expect(nextAliases(second, withAreas(["beta", "gamma"]))).toEqual({});
    // deleting an area (no pairing) writes no alias
    expect(nextAliases(withAreas(["a1", "b1", "c1"]), withAreas(["a1", "b1"]))).toEqual({});
  });
});

function ctxFor(replyFor: (job: Job) => unknown = () => ({})) {
  const store = createMemoryStore();
  const jobs: Array<{ job: Job; opts: { model?: string } }> = [];
  const runner: Runner = {
    status: () => ({ running: 0, queued: 0 }),
    runJob: (async (job: Job, opts: { model?: string } = {}) => {
      jobs.push({ job, opts });
      return job.validate(replyFor(job));
    }) as Runner["runJob"],
  };
  const ctx: FeatureCtx = {
    store,
    settings: () => ({ ...DEFAULT_SETTINGS, judgeModel: "big" }),
    framework: async () => (await store.get(KIND.framework, "active", (await import("../lib/types")).roleFrameworkSchema)) ?? DEFAULT_FRAMEWORK,
    runner,
    log: { info: () => undefined, warn: () => undefined },
    publish: () => undefined,
    now: () => NOW,
  };
  return { ctx, store, jobs };
}

describe("framework service", () => {
  it("get returns the default and presets; set stores and renames alias; usePreset keeps the subject", async () => {
    const { ctx, store } = ctxFor();
    const svc = createFrameworkService(ctx);
    const first = await svc.get();
    expect(first.framework.id).toBe("default");
    expect(first.presets).toEqual(PRESET_FRAMEWORKS.map((p) => ({ id: p.id, name: p.name })));

    const renamed = withAreas(DEFAULT_FRAMEWORK.areas.map((a) => (a.key === "mentorship" ? "coaching" : a.key)), { subject: { name: "Alex", pronoun: "they" } });
    const saved = await svc.set(renamed);
    expect(saved.areaAliases).toEqual({ mentorship: "coaching" });
    expect((await store.get(KIND.framework, "active", (await import("../lib/types")).roleFrameworkSchema))?.areas.some((a) => a.key === "coaching")).toBe(true);

    const preset = await svc.usePreset("default");
    expect(preset.subject.name).toBe("Alex");
    expect(preset.areas.some((a) => a.key === "mentorship")).toBe(true);
    expect(preset.areaAliases).toEqual({ coaching: "mentorship" }); // the preset renames coaching back in place, so old weeks still resolve
    await expect(svc.usePreset("nope")).rejects.toThrow(/Unknown preset/);
  });
});

describe("validateTargets", () => {
  const fw = DEFAULT_FRAMEWORK;
  const targets = (t: Record<string, number>): AllocationTargets => ({ version: 1, frameworkId: "x", targets: t, windowWeeks: 4, thresholds: { watch: 10, off: 20 }, updatedAt: "" });
  it("accepts a sum of 100 +-1 over the framework's areas and stamps the framework id", () => {
    const out = validateTargets(targets({ delivery: 50, mentorship: 50 }), fw, NOW);
    expect(out.frameworkId).toBe("default");
    expect(out.updatedAt).toBe(NOW.toISOString());
    expect(() => validateTargets(targets({ delivery: 50.5, mentorship: 50 }), fw, NOW)).not.toThrow();
    expect(() => validateTargets(targets({ delivery: 49, mentorship: 50 }), fw, NOW)).not.toThrow();
  });
  it("rejects sums off by more than 1 and keys outside the framework", () => {
    expect(() => validateTargets(targets({ delivery: 40, mentorship: 40 }), fw, NOW)).toThrow(/sum to 100/);
    expect(() => validateTargets(targets({ delivery: 60, mentorship: 45 }), fw, NOW)).toThrow(/sum to 100/);
    expect(() => validateTargets(targets({ delivery: 50, ghost_area: 50 }), fw, NOW)).toThrow(/not in the framework: ghost_area/);
  });
  it("service stores targets under active", async () => {
    const { ctx, store } = ctxFor();
    const svc = createFrameworkService(ctx);
    expect(await svc.getTargets()).toBeNull();
    await svc.setTargets(targets({ delivery: 70, direction: 30 }));
    expect((await svc.getTargets())?.targets).toEqual({ delivery: 70, direction: 30 });
    expect(await store.getMeta("x")).toBeNull();
  });
});

describe("import-doc proposal validator", () => {
  const proposal = (n: number) => ({
    name: "Senior engineer",
    areas: Array.from({ length: n }, (_, i) => ({ key: `Area ${i}`, label: `Area ${i}`, description: "d", kind: i === 0 ? "leverage" : "weird" })),
    rubric: { bar: "b", exceeds: "e", meets: "m", needsImprovement: "n", extraRules: ["r"] },
    roleDoc: "condensed",
  });
  it("rejects fewer than 2 or more than 10 areas", () => {
    expect(() => validateProposal(proposal(1), DEFAULT_FRAMEWORK, NOW)).toThrow(/at least 2/);
    expect(() => validateProposal(proposal(0), DEFAULT_FRAMEWORK, NOW)).toThrow(/at least 2/);
    expect(() => validateProposal(proposal(11), DEFAULT_FRAMEWORK, NOW)).toThrow(/at most 10/);
    expect(() => validateProposal({ areas: "x" }, DEFAULT_FRAMEWORK, NOW)).toThrow();
  });
  it("accepts 2 to 10, slugifies keys, keeps the subject and falls back to the base rubric", () => {
    const fw = validateProposal(proposal(10), DEFAULT_FRAMEWORK, NOW);
    expect(fw.areas).toHaveLength(10);
    expect(fw.areas[0]).toMatchObject({ key: "area_0", kind: "leverage" });
    expect(fw.areas[1]?.kind).toBe("other");
    expect(fw.id).toBe("imported");
    const bare = validateProposal({ areas: areas(["x1", "y1"]) }, DEFAULT_FRAMEWORK, NOW);
    expect(bare.rubric.meets).toBe(DEFAULT_FRAMEWORK.rubric.meets);
    expect(bare.subject).toEqual(DEFAULT_FRAMEWORK.subject);
  });
  it("rejects duplicate keys after slugging and surfaces a model-reported error", () => {
    expect(() => validateProposal({ areas: [{ key: "A B" }, { key: "a_b" }] }, DEFAULT_FRAMEWORK, NOW)).toThrow(/duplicate/);
    const job = importDocJob({ kind: "url", value: "https://example.com/role" }, DEFAULT_FRAMEWORK, () => NOW);
    expect(() => job.validate({ error: "login required" })).toThrow(/login required/);
  });
});

describe("startImport", () => {
  it("stores a running proposal, then a ready one, and never touches the active framework", async () => {
    const { ctx, store, jobs } = ctxFor(() => ({ areas: areas(["a1", "b1"]) }));
    await startImport(ctx, { kind: "text", value: "Senior engineers lead design." });
    expect((await readProposal(store))?.status).toMatch(/running|ready/);
    await new Promise((r) => setTimeout(r, 0));
    const done = await readProposal(store);
    expect(done?.status).toBe("ready");
    expect(done?.framework?.areas).toHaveLength(2);
    expect(done?.sourceRef).toContain("pasted text");
    expect(jobs[0]?.opts.model).toBe("big");
    expect(jobs[0]?.job.prompt).toContain("Senior engineers lead design.");
    expect(await store.get(KIND.framework, "active", (await import("../lib/types")).roleFrameworkSchema)).toBeNull();
  });

  it("records a failed proposal with the error, and validates the reference", async () => {
    const { ctx, store } = ctxFor(() => ({ areas: areas(["only"]) }));
    await startImport(ctx, { kind: "url", value: "https://example.com/doc" });
    await new Promise((r) => setTimeout(r, 0));
    const failed = await readProposal(store);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toMatch(/at least 2/);
    await expect(startImport(ctx, { kind: "url", value: "ftp://x" })).rejects.toThrow(/http/);
    await expect(startImport(ctx, { kind: "note", value: "  " })).rejects.toThrow(/empty/);
  });

  it("refuses a second import while one is running", async () => {
    const { ctx, store } = ctxFor();
    await store.set(KIND.framework, "proposal", { status: "running", sourceRef: "x", framework: null, error: null, at: NOW.toISOString() });
    await expect(startImport(ctx, { kind: "text", value: "doc" })).rejects.toThrow(/already running/);
  });
});

