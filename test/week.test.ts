import { describe, expect, it } from "vitest";
import { rpcContract } from "../lib/contract";
import type { FeatureCtx } from "../lib/engine/extensions";
import type { Job } from "../lib/engine/runner";
import { handlers } from "../lib/handlers/plan";
import { DEFAULT_FRAMEWORK } from "../lib/framework/default";
import { DEFAULT_SETTINGS } from "../lib/settings";
import { createMemoryStore } from "../lib/storage/memory";
import { KIND } from "../lib/storage/port";
import { weekPlanSchema, type PlanResult } from "../lib/types";
import { planItem, weekPlan } from "./fixtures";

// Friday 2026-11-13 10:00 in New York: the default week to plan is next week, 2026-W47.
const NOW = "2026-11-13T15:00:00Z";

const REPLY = {
  intent: { headline: "Land the limiter", why: "It unblocks launch.", focusGoalIds: [] },
  commitments: [{ text: "Ship the limiter", kind: "deliver", doneWhen: "PR merged", area: "delivery", refs: [{ kind: "ticket", label: "ACME-12", url: "ACME-12" }] }],
  shape: { meetingHours: 8, meetingCount: 6, focusHours: 32, keyMeetings: [] },
  backlog: { considered: 10, deferred: [] },
};

function make() {
  const store = createMemoryStore();
  const jobs: Job[] = [];
  let published = 0;
  const ctx: FeatureCtx = {
    store,
    settings: () => ({ ...DEFAULT_SETTINGS, timeZone: "America/New_York" }),
    framework: async () => DEFAULT_FRAMEWORK,
    runner: { status: () => ({ running: 0, queued: 0 }), runJob: async (job: Job) => (jobs.push(job), job.validate(REPLY)) } as unknown as FeatureCtx["runner"],
    log: { info() {}, warn() {} },
    publish: () => void (published += 1),
    now: () => new Date(NOW),
  };
  const api = handlers(ctx, {} as never, {} as never);
  const waitFor = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 100; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("timed out");
  };
  return { store, jobs, api, waitFor, published: () => published };
}

describe("plan.now", () => {
  it("returns at once, then plans next week (it is Friday), stores the scan and publishes", async () => {
    const t = make();
    expect(await t.api["plan.now"]({})).toEqual({ ok: true });
    await t.waitFor(async () => (await t.store.get(KIND.plan, "2026-W47", weekPlanSchema)) !== null);
    const plan = (await t.store.get(KIND.plan, "2026-W47", weekPlanSchema))!;
    expect(t.jobs.map((j) => j.kind)).toEqual(["plan-week"]);
    expect(plan.items.map((i) => [i.text, i.source, i.doneWhen])).toEqual([["Ship the limiter", "inferred", "PR merged"]]);
    expect(plan).toMatchObject({ plannedFor: "manual_trigger", intent: { headline: "Land the limiter" }, shape: { meetingCount: 6 }, backlog: { considered: 10 } });
    expect(t.published()).toBeGreaterThan(0);
    expect(await t.store.get(KIND.plan, "2026-W46", weekPlanSchema)).toBeNull();
    // and plan.get serves it
    expect((await t.api["plan.get"]({ week: "2026-W47" })).items).toHaveLength(1);
  });

  it("plans the week it is given", async () => {
    const t = make();
    await t.api["plan.now"]({ week: "2026-W46" });
    await t.waitFor(async () => (await t.store.get(KIND.plan, "2026-W46", weekPlanSchema)) !== null);
    expect(await t.store.get(KIND.plan, "2026-W47", weekPlanSchema)).toBeNull();
  });

  it("refuses a week that is not real, and the contract only takes ISO weeks", () => {
    const t = make();
    expect(() => t.api["plan.now"]({ week: "2026-W99" })).toThrow(/not a real week/);
    const input = (rpcContract as any)["plan.now"].input;
    expect(input.safeParse({}).success).toBe(true);
    expect(input.safeParse({ week: "2026-W47" }).success).toBe(true);
    expect(input.safeParse({ week: "next week" }).success).toBe(false);
  });

  it("does not replace a plan the user made", async () => {
    const t = make();
    await t.store.set(KIND.plan, "2026-W45", weekPlan({ week: "2026-W45", items: [planItem({ id: "m1", week: "2026-W45", text: "Mine" })] }));
    await t.api["plan.now"]({ week: "2026-W45" });
    await new Promise((r) => setTimeout(r, 30));
    expect(t.jobs).toEqual([]);
    expect((await t.store.get(KIND.plan, "2026-W45", weekPlanSchema))!.items.map((i) => i.id)).toEqual(["m1"]);
  });
});

describe("plan.accuracy", () => {
  const res = (itemId: string, status: PlanResult["status"]): PlanResult => ({ itemId, status, note: "", evidenceIds: status === "done" ? ["x"] : [] });
  const judged = (week: string, statuses: PlanResult["status"][]) => {
    const items = statuses.map((_, i) => planItem({ id: `${week}-${i}`, week }));
    return weekPlan({ week, items, results: statuses.map((s, i) => res(`${week}-${i}`, s)), hitRate: 0, judgedAt: NOW });
  };

  it("aggregates the judged weeks in the window, oldest first, with the calibration note", async () => {
    const t = make();
    await t.store.set(KIND.plan, "2026-W45", judged("2026-W45", ["done", "partial", "not_done", "dropped"]));
    await t.store.set(KIND.plan, "2026-W44", judged("2026-W44", ["done", "done"]));
    await t.store.set(KIND.plan, "2026-W30", judged("2026-W30", ["not_done", "not_done"])); // outside a 4-week window
    await t.store.set(KIND.plan, "2026-W46", weekPlan({ week: "2026-W46", items: [planItem({ id: "u", week: "2026-W46" })] })); // this week, not judged yet
    const out = await t.api["plan.accuracy"]({ weeks: 4 });
    expect(out.byWeek).toEqual([
      { week: "2026-W44", hitRate: 1, committed: 2, hit: 2 },
      { week: "2026-W45", hitRate: 0.5, committed: 3, hit: 1 },
    ]);
    expect(out.overall).toBeCloseTo(3.5 / 5);
    expect(out.note).toMatch(/^Plans hit 70% over 2 weeks/);
    // a wider window picks up the old, bad week
    const wide = await t.api["plan.accuracy"]({ weeks: 20 });
    expect(wide.byWeek.map((w) => w.week)).toEqual(["2026-W30", "2026-W44", "2026-W45"]);
  });

  it("with nothing judged returns an empty trend and says so", async () => {
    const out = await make().api["plan.accuracy"]({ weeks: 12 });
    expect(out).toMatchObject({ byWeek: [], overall: null });
    expect(out.note).toMatch(/No judged weeks/);
  });
});
