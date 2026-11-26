import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRegistry, runTickHooks, type FeatureCtx } from "../lib/engine/extensions";
import type { Job } from "../lib/engine/runner";
import { planWeekNow, register } from "../lib/features/plan";
import { autoPlanDue, planAutoKey, weekToPlan } from "../lib/features/plan/auto";
import { refreshGoalTasks } from "../lib/features/goals/tasks";
import { DEFAULT_FRAMEWORK } from "../lib/framework/default";
import { DEFAULT_SETTINGS } from "../lib/settings";
import { createMemoryStore } from "../lib/storage/memory";
import { planItem, weekPlan } from "./fixtures";
import { KIND } from "../lib/storage/port";
import { goalsSchema, profileSchema, weekPlanSchema, type PlanItem } from "../lib/types";

// The tick only plans; refreshing the goal tasks is its own job and has its own tests.
vi.mock("../lib/features/goals/tasks", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/features/goals/tasks")>()), refreshGoalTasks: vi.fn(async () => undefined) }));
beforeEach(() => vi.mocked(refreshGoalTasks).mockClear());

// 2026-11-09 is a Monday (ISO week 2026-W46). New York is UTC-5 then.
const WEEK = "2026-W46";
const MON_0659 = "2026-11-09T11:59:00Z";
const MON_0700 = "2026-11-09T12:00:00Z";
const TUE_1000 = "2026-11-10T15:00:00Z";
const WED_1800 = "2026-11-11T23:00:00Z";
const THU_1000 = "2026-11-12T15:00:00Z";
const FRI_1000 = "2026-11-13T15:00:00Z";
const SUN_1000 = "2026-11-15T15:00:00Z";

const REPLY = {
  intent: { headline: "Land the rate limiter", why: "It unblocks the launch.", focusGoalIds: ["g1"] },
  commitments: [
    { text: "Ship the rate limiter", kind: "deliver", doneWhen: "The pull request is merged", area: "delivery", goalId: "g1", refs: [{ kind: "ticket", label: "ACME-12", url: "ACME-12" }] },
    { text: "Review the queue design", kind: "review", doneWhen: "Comments are posted", area: "bogus", refs: [{ kind: "pr", label: "PR 7", url: "https://github.com/acme/api/pull/7" }] },
  ],
  shape: { meetingHours: 11, meetingCount: 9, focusHours: 29, keyMeetings: [{ title: "Design review", date: "2026-11-11", why: "Needs the doc" }] },
  backlog: { considered: 14, deferred: [{ label: "ACME-30 Logging cleanup", why: "Not tied to a goal" }] },
};

function harness(first: string = MON_0700) {
  const store = createMemoryStore();
  const clock = { now: new Date(first) };
  const warnings: string[] = [];
  const jobs: Job[] = [];
  const hooks = { duringRun: undefined as undefined | (() => Promise<void>), fail: false, reply: undefined as unknown, release: undefined as undefined | Promise<void> };
  const runner = {
    status: () => ({ running: 0, queued: 0 }),
    runJob: async (job: Job) => {
      jobs.push(job);
      if (hooks.release) await hooks.release;
      if (hooks.duringRun) await hooks.duringRun();
      if (hooks.fail) throw new Error("worker failed");
      return job.validate(hooks.reply ?? REPLY);
    },
  } as unknown as FeatureCtx["runner"];
  const ctx: FeatureCtx = {
    store,
    settings: () => ({ ...DEFAULT_SETTINGS, timeZone: "America/New_York" }),
    framework: async () => DEFAULT_FRAMEWORK,
    runner,
    log: { info: () => undefined, warn: (m) => void warnings.push(m) },
    publish: () => undefined,
    now: () => clock.now,
  };
  const reg = createRegistry();
  register(reg);
  const tick = () => Promise.all(runTickHooks(reg, ctx));
  const plan = (week: string = WEEK) => store.get(KIND.plan, week, weekPlanSchema);
  return { store, clock, jobs, hooks, ctx, reg, tick, plan, warnings };
}

const manualItem = (): PlanItem => planItem({ id: "m1", week: WEEK, text: "My own plan", createdAt: MON_0700 });

describe("the plan tick hook", () => {
  it("registers one tick hook", () => {
    const reg = createRegistry();
    register(reg);
    expect(reg.tickHooks.map((h) => h.id)).toEqual(["plan"]);
  });

  it("does not run before 07:00 on the first workday", async () => {
    const h = harness(MON_0659);
    await h.tick();
    await h.tick();
    expect(h.jobs).toEqual([]);
    expect(await h.store.getMeta(planAutoKey(WEEK))).toBeNull();
    expect(await h.plan()).toBeNull();
  });

  it("at 07:00 plans the week once: inferred items, areas checked, intent and shape kept, flag written", async () => {
    const h = harness();
    await h.tick();
    expect(h.jobs).toHaveLength(1);
    expect(h.jobs[0]!.kind).toBe("plan-week");
    expect(h.jobs[0]!.tools).toBe("read");
    const plan = await h.plan();
    expect(plan!.items.map((i) => [i.text, i.source, i.area, i.externalRef, i.kind, i.doneWhen])).toEqual([
      ["Ship the rate limiter", "inferred", "delivery", "ACME-12", "deliver", "The pull request is merged"],
      ["Review the queue design", "inferred", null, "https://github.com/acme/api/pull/7", "review", "Comments are posted"],
    ]);
    expect(plan).toMatchObject({ plannedFor: "auto", intent: { headline: "Land the rate limiter" }, shape: { meetingCount: 9 }, backlog: { considered: 14 } });
    expect(plan!.plannedAt).not.toBeNull();
    expect(await h.store.getMeta(planAutoKey(WEEK))).not.toBeNull();
    // later ticks, the same day or later in the week, find the flag
    await h.tick();
    h.clock.now = new Date(TUE_1000);
    await h.tick();
    expect(h.jobs).toHaveLength(1);
  });

  it("overlapping ticks start exactly one run", async () => {
    const h = harness();
    let release!: () => void;
    h.hooks.release = new Promise<void>((r) => (release = r));
    const ticks = Promise.all([h.tick(), h.tick(), h.tick(), h.tick()]);
    await new Promise((r) => setTimeout(r, 10));
    expect(h.jobs).toHaveLength(1); // still running, others bounced off the guard or the flag
    release();
    await ticks;
    expect(h.jobs).toHaveLength(1);
    expect((await h.plan())!.items).toHaveLength(2);
  });

  it("does not run when a manual plan exists", async () => {
    const h = harness();
    await h.store.set(KIND.plan, WEEK, weekPlan({ items: [manualItem()] }));
    await h.tick();
    expect(h.jobs).toEqual([]);
    expect((await h.plan())!.items.map((i) => i.id)).toEqual(["m1"]);
  });

  it("a plan the user writes while the job runs wins", async () => {
    const h = harness();
    h.hooks.duringRun = () => h.store.set(KIND.plan, WEEK, weekPlan({ items: [manualItem()] }));
    await h.tick();
    expect(h.jobs).toHaveLength(1);
    expect((await h.plan())!.items.map((i) => [i.id, i.source])).toEqual([["m1", "manual"]]);
  });

  it("a failed run is logged and not retried that week", async () => {
    const h = harness();
    h.hooks.fail = true;
    await h.tick();
    expect(h.warnings.join("\n")).toMatch(/tick hook plan failed: worker failed/);
    h.hooks.fail = false;
    await h.tick();
    expect(h.jobs).toHaveLength(1);
    expect(await h.plan()).toBeNull();
  });

  it("puts the goals, last week's unfinished items and the user's identity in the prompt", async () => {
    const h = harness();
    await h.store.set(KIND.goals, "active", goalsSchema.parse({ goals: [{ id: "g1", text: "Cut p95 latency by a third", area: null, source: "setup", basis: null, createdAt: MON_0700 }] }));
    await h.store.set(KIND.profile, "active", profileSchema.parse({ identity: { name: "Alex Doe", email: "alex@acme.test", handles: { github: "alexdoe" } } }));
    await h.store.set(KIND.plan, "2026-W45", weekPlan({
      week: "2026-W45",
      items: [{ ...manualItem(), id: "old", week: "2026-W45", text: "Finish the migration runbook", doneWhen: "Runbook reviewed" }],
      results: [{ itemId: "old", status: "not_done", note: "", evidenceIds: [] }],
      hitRate: 0,
      judgedAt: MON_0700,
    }));
    await h.tick();
    const prompt = h.jobs[0]!.prompt;
    expect(prompt).toContain("Cut p95 latency by a third");
    expect(prompt).toContain("Finish the migration runbook");
    expect(prompt).toContain("Alex Doe");
    expect(prompt).toContain("alex@acme.test");
    expect(prompt).toContain("Missed: Finish the migration runbook");
    expect(prompt).toContain("Runbook reviewed");
    const plan = await h.plan();
    expect(plan!.items.every((i) => i.source === "inferred")).toBe(true);
  });
});

describe("the tick catches up through Wednesday", () => {
  it.each([["Tuesday", TUE_1000], ["Wednesday", WED_1800]])("plans a week nobody has planned yet on %s", async (_day, at) => {
    const h = harness(at);
    await h.tick();
    expect(h.jobs).toHaveLength(1);
    expect((await h.plan())!.items).toHaveLength(2);
  });
  it.each([["Thursday", THU_1000], ["Friday", FRI_1000], ["Sunday", SUN_1000]])("does not plan on %s", async (_day, at) => {
    const h = harness(at);
    await h.tick();
    expect(h.jobs).toEqual([]);
    expect(await h.store.getMeta(planAutoKey(WEEK))).toBeNull();
  });
});

describe("the setup trigger", () => {
  it("weekToPlan: this week Monday to Thursday, next week Friday to Sunday (local)", () => {
    const wk = (iso: string) => weekToPlan(new Date(iso), "America/New_York");
    expect([MON_0659, MON_0700, TUE_1000, WED_1800, THU_1000].map(wk)).toEqual(Array(5).fill(WEEK));
    expect([FRI_1000, SUN_1000].map(wk)).toEqual(["2026-W47", "2026-W47"]);
    // local, not UTC: 04:30Z on the 16th is still Sunday 23:30 in New York (next week); 05:30Z is Monday 00:30 (this week, W47)
    expect(wk("2026-11-16T04:30:00Z")).toBe("2026-W47");
    expect(wk("2026-11-16T05:30:00Z")).toBe("2026-W47");
    expect(wk("2026-11-13T04:30:00Z")).toBe("2026-W46"); // Thursday 23:30 local, though UTC says Friday
  });
  it("on Monday to Thursday plans this week", async () => {
    for (const at of [MON_0700, THU_1000]) {
      const h = harness(at);
      expect(await planWeekNow(h.ctx, undefined, "setup")).toBe("planned");
      expect(await h.plan()).toMatchObject({ plannedFor: "setup" });
      expect(await h.plan("2026-W47")).toBeNull();
    }
  });
  it("on Friday to Sunday plans next week", async () => {
    for (const at of [FRI_1000, SUN_1000]) {
      const h = harness(at);
      expect(await planWeekNow(h.ctx, undefined, "setup")).toBe("planned");
      expect(await h.plan("2026-W47")).toMatchObject({ plannedFor: "setup" });
      expect(await h.plan()).toBeNull();
    }
  });
  it("never overwrites a manual plan, for any trigger", async () => {
    for (const trigger of ["setup", "auto", "manual_trigger"] as const) {
      const h = harness();
      await h.store.set(KIND.plan, WEEK, weekPlan({ items: [manualItem()] }));
      expect(await planWeekNow(h.ctx, undefined, trigger)).toBe("skipped");
      expect(h.jobs).toEqual([]);
      expect((await h.plan())!.items.map((i) => i.id)).toEqual(["m1"]);
    }
  });
  it("a plan the agent made is replaced only by an explicit request, and one the user has edited or judged never is", async () => {
    const h = harness();
    await planWeekNow(h.ctx, undefined, "setup");
    const first = (await h.plan())!.items.map((i) => i.id);
    expect(await planWeekNow(h.ctx, undefined, "setup")).toBe("skipped");
    expect((await h.plan())!.items.map((i) => i.id)).toEqual(first);
    expect(await planWeekNow(h.ctx, undefined, "manual_trigger")).toBe("planned");
    const second = (await h.plan())!;
    expect(second.items.map((i) => i.id)).not.toEqual(first);
    expect(second.plannedFor).toBe("manual_trigger");
    await h.store.set(KIND.plan, WEEK, { ...second, items: [...second.items, manualItem()] });
    expect(await planWeekNow(h.ctx, undefined, "manual_trigger")).toBe("skipped");
    await h.store.set(KIND.plan, WEEK, { ...second, judgedAt: MON_0700 });
    expect(await planWeekNow(h.ctx, undefined, "manual_trigger")).toBe("skipped");
  });
  it("overlapping requests for one week start one run; the others report busy", async () => {
    const h = harness();
    let release!: () => void;
    h.hooks.release = new Promise<void>((r) => (release = r));
    const calls = [planWeekNow(h.ctx, undefined, "setup"), planWeekNow(h.ctx, undefined, "manual_trigger"), planWeekNow(h.ctx, WEEK, "setup")];
    await new Promise((r) => setTimeout(r, 10));
    expect(h.jobs).toHaveLength(1);
    release();
    expect((await Promise.all(calls)).sort()).toEqual(["busy", "busy", "planned"]);
    expect(h.jobs).toHaveLength(1);
  });
  it("a failed run reports failed and leaves no plan", async () => {
    const h = harness();
    h.hooks.fail = true;
    expect(await planWeekNow(h.ctx, undefined, "setup")).toBe("failed");
    expect(await h.plan()).toBeNull();
  });
});

describe("goal tasks before the scan", () => {
  const withGoal = (h: ReturnType<typeof harness>, tasksRefreshedAt: string | null, tasks: unknown[] = []) =>
    h.store.set(KIND.goals, "active", goalsSchema.parse({ goals: [{ id: "g1", text: "Cut latency", source: "setup", createdAt: MON_0700, tasks }], tasksRefreshedAt }));
  const aTask = { id: "t1", text: "Ship limiter", ref: null, source: "agent", status: "open", updatedWeek: null, evidenceIds: [] };
  it("refreshes tasks that were never made or are older than six days, and a failed refresh does not stop the scan", async () => {
    const h = harness();
    await withGoal(h, null);
    vi.mocked(refreshGoalTasks).mockRejectedValueOnce(new Error("no backlog"));
    expect(await planWeekNow(h.ctx, undefined, "setup")).toBe("planned");
    expect(refreshGoalTasks).toHaveBeenCalledTimes(1);
    expect(h.warnings.join("\n")).toMatch(/goal tasks could not be refreshed: no backlog/);
    const old = harness();
    await withGoal(old, "2026-11-02T12:00:00.000Z");
    await planWeekNow(old.ctx, undefined, "setup");
    expect(refreshGoalTasks).toHaveBeenCalledTimes(2);
  });
  it("leaves fresh tasks and a goal-less setup alone", async () => {
    const fresh = harness();
    await withGoal(fresh, "2026-11-08T12:00:00.000Z", [aTask]);
    await planWeekNow(fresh.ctx, undefined, "setup");
    await planWeekNow(harness().ctx, undefined, "setup");
    expect(refreshGoalTasks).not.toHaveBeenCalled();
  });
});

describe("goals without tasks", () => {
  const goalAt = (h: ReturnType<typeof harness>, at: string) =>
    h.store.set(KIND.goals, "active", goalsSchema.parse({ goals: [{ id: "g1", text: "Cut latency", source: "setup", createdAt: MON_0700 }], tasksRefreshedAt: at }));
  it("refreshes when a goal has no tasks even though the last refresh is recent, but not within ten minutes", async () => {
    const h = harness();
    await goalAt(h, "2026-11-08T12:00:00.000Z");
    await planWeekNow(h.ctx, undefined, "setup");
    expect(refreshGoalTasks).toHaveBeenCalledTimes(1);
    const again = harness();
    await goalAt(again, "2026-11-09T11:55:00.000Z");
    await planWeekNow(again.ctx, undefined, "setup");
    expect(refreshGoalTasks).toHaveBeenCalledTimes(1);
  });
});

describe("a long unlabelled ref", () => {
  it("is clipped to the label limit so the stored plan reads back", async () => {
    const url = `https://example.atlassian.net/wiki/spaces/ENG/pages/123456789/${"A-Very-Long-Page-Title-".repeat(5)}`.slice(0, 172);
    expect(url).toHaveLength(172);
    const h = harness();
    h.hooks.reply = { ...REPLY, commitments: [{ text: "Update the runbook", kind: "prep", doneWhen: "Runbook published", refs: [{ kind: "doc", url }] }] };
    expect(await planWeekNow(h.ctx, undefined, "setup")).toBe("planned");
    const stored = await h.plan();
    expect(stored).not.toBeNull();
    const ref = stored!.items[0]!.refs[0]!;
    expect(ref.url).toBe(url);
    expect(ref.label.length).toBeLessThanOrEqual(120);
  });
});

describe("autoPlanDue", () => {
  const NY = "America/New_York";
  const due = (iso: string) => autoPlanDue(new Date(iso), NY, WEEK);
  it("is due from Monday 07:00 through Wednesday", () => {
    expect(due(MON_0700)).toBe(true);
    expect(due(TUE_1000)).toBe(true);
    expect(due(WED_1800)).toBe(true); // Wednesday 18:00
  });
  it("is not due before Monday 07:00", () => {
    expect(due(MON_0659)).toBe(false);
  });
  it("skips a week missed by Wednesday", () => {
    expect(due("2026-11-12T15:00:00Z")).toBe(false); // Thursday
    expect(due("2026-11-14T15:00:00Z")).toBe(false); // Saturday
  });
});
