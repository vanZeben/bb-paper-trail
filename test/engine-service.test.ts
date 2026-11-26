import { describe, expect, it } from "vitest";
import { addDays, weekDates } from "../lib/engine/dates";
import { createRegistry, type FeatureCtx, type PromptExtension } from "../lib/engine/extensions";
import type { Job, Runner } from "../lib/engine/runner";
import { INDEX_ID, WORKLOG_DAILY_SLOT_KEY, WORKLOG_WEEKLY_SLOT_KEY, catchupKey, createWorklogService, weekEndTime } from "../lib/engine/service";
import { DEFAULT_FRAMEWORK } from "../lib/framework/default";
import { DEFAULT_SETTINGS, type Settings } from "../lib/settings";
import { KIND } from "../lib/storage/port";
import { createMemoryStore } from "../lib/storage/memory";
import { SOURCE_IDS, profileSchema, workDaySchema, workWeekSchema, worklogIndexSchema, type ConnectorCheck, type SourceId, type SourcePart, type WorkDay, type WorkWeek } from "../lib/types";

// 2026-11-13 is a Friday (ISO week 2026-W46). New York is UTC-5 then.
const THU_EVENING = "2026-11-12T22:55:00Z"; // 17:55 local
const MON_EVENING = "2026-11-09T22:50:00Z"; // 17:50 local
const FRI_1805 = "2026-11-13T23:05:00Z"; // 18:05 local, just after the weekly slot
const FRI_1630 = "2026-11-13T21:30:00Z"; // 16:30 local
const FRI_1750 = "2026-11-13T22:50:00Z"; // 17:50 local
const NEXT_MON_1750 = "2026-11-16T22:50:00Z";
const ok = { status: "ok", note: null } as const;
const AREAS = DEFAULT_FRAMEWORK.areas.map((a) => a.key);

function connectorCheck(sources: Partial<Record<SourceId, { available: boolean | null; mode?: "gh" | "mcp" | null; note?: string }>>): ConnectorCheck {
  return {
    checkedAt: "2026-11-01T00:00:00Z",
    hostId: "h1",
    hostName: "host",
    model: null,
    sources: Object.fromEntries(Object.entries(sources).map(([id, s]) => [id, { available: s.available, via: null, account: null, note: s.note ?? null, mode: s.mode ?? null }])),
  };
}

function harness(overrides: Partial<Settings> = {}) {
  const store = createMemoryStore();
  const clock = { now: new Date(THU_EVENING) };
  const jobs: Array<{ kind: string; prompt: string; opts: { model?: string } }> = [];
  const fail = new Set<string>();
  const scenario = {
    granolaFail: false,
    granolaNotes: [] as Array<{ title: string; start: string | null; passive: boolean }>,
    planReply: undefined as unknown,
    onboarded: true,
    connectors: null as ConnectorCheck | null,
  };
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    timeZone: "America/New_York",
    enabled: true,
    captureModel: "haiku",
    judgeModel: "opus",
    captureTimeoutMinutes: 1,
    judgeTimeoutMinutes: 2,
    githubOrg: "acme",
    watchedChannels: "eng-help",
    ...overrides,
  };
  const today = () => clock.now.toISOString().slice(0, 10);
  const wide = (make: (d: string) => SourcePart): Record<string, SourcePart> => {
    const out: Record<string, SourcePart> = {};
    for (let d = "2026-09-01"; d <= "2026-11-30"; d = addDays(d, 1)) out[d] = make(d);
    return out;
  };

  const runner: Runner = {
    status: () => ({ running: 0, queued: 0 }),
    runJob: (async (job: Job, opts: { model?: string } = {}) => {
      jobs.push({ kind: job.kind, prompt: job.prompt, opts });
      if (fail.has(job.kind)) throw new Error(`${job.kind} worker failed`);
      const date = /(\d{4}-\d{2}-\d{2})/.exec(job.prompt)?.[1] ?? "";
      const mmdd = date.slice(5).replace("-", "");
      switch (job.kind) {
        case "worklog-meetings": {
          const hasGranola = job.prompt.includes("Granola");
          const hasFellow = job.prompt.includes("Fellow");
          const off = { coverage: { status: "off", note: "not connected" }, entries: [], notes: [] };
          return {
            calendar: { coverage: ok, meetings: [{ title: "Design sync", start: `${date}T15:00:00Z`, end: `${date}T16:00:00Z`, minutes: 60, response: "accepted", attendees: 4, noted: false, passive: null }] },
            granola: !hasGranola ? off : scenario.granolaFail ? { coverage: { status: "failed", note: "notes down" }, entries: [], notes: [] } : { coverage: ok, entries: [], notes: scenario.granolaNotes },
            fellow: !hasFellow ? off : { coverage: ok, entries: [{ date, source: "fellow", kind: "proposal", what: "Design sync: proposed X", link: null, outcome: null }], notes: [] },
          };
        }
        case "worklog-slack":
          return { coverage: ok, entries: [{ date, source: "slack", kind: "help_given", what: "Unblocked a thread", link: null, outcome: null }] };
        case "worklog-github":
          return wide(() => ({ coverage: ok, entries: [] }));
        case "worklog-jira":
          return wide((d) => ({ coverage: ok, entries: [{ date: d, source: "jira", kind: "resolved", what: "Closed ACME-1", link: null, outcome: null }] }));
        case "worklog-confluence":
          return wide((d) => ({ coverage: ok, entries: [{ date: d, source: "confluence", kind: "doc_edited", what: 'Edited "ADR"', link: null, outcome: null }] }));
        case "worklog-context":
          return {
            vault: wide(() => ({ coverage: ok, entries: [] })),
            memory: wide((d) => ({ coverage: ok, entries: [{ date: d, source: "memory", kind: "decision", what: "Decided X", link: null, outcome: null }] })),
          };
        case "worklog-rate-day":
          return job.validate({ date, rating: "meets", reason: "Reviewed and unblocked", summary: "A day.", areas: ["delivery"], evidenceIds: [`C${mmdd}-1`] });
        case "worklog-judge-week": {
          const week = /(\d{4}-W\d{2})/.exec(job.prompt)![1]!;
          const days = weekDates(week).map((d) =>
            d <= today()
              ? { date: d, rating: "exceeds", reason: "Strong day", summary: "s", areas: ["delivery"], evidenceIds: [`C${d.slice(5).replace("-", "")}-1`] }
              : { date: d, rating: "none", reason: "not yet", summary: "", areas: [], evidenceIds: [] },
          );
          return job.validate({
            week,
            rating: "meets",
            ratingReason: "Solid",
            threeLines: ["a", "b", "c"],
            days,
            scorecard: AREAS.map((area) => ({ area, status: "partial", note: "n", evidenceIds: [] })),
            shipped: [{ text: "Shipped X", evidenceIds: [] }],
            raiseWithManager: [{ text: "Raise Y", evidenceIds: [] }],
            reflection: { goodWeek: true, text: "Good." },
            ...(scenario.planReply === undefined ? {} : { plan: scenario.planReply }),
          });
        }
      }
      throw new Error(`unexpected job ${job.kind}`);
    }) as Runner["runJob"],
  };

  const warnings: string[] = [];
  const log = { info: () => undefined, warn: (m: string) => void warnings.push(m) };
  const registry = createRegistry();
  const ctx: FeatureCtx = { store, settings: () => settings, framework: async () => DEFAULT_FRAMEWORK, runner, log, publish: () => undefined, now: () => clock.now };
  const service = createWorklogService({
    store,
    runner,
    registry,
    ctx,
    settings: () => settings,
    framework: async () => DEFAULT_FRAMEWORK,
    connectors: async () => scenario.connectors,
    onboarded: async () => scenario.onboarded,
    notify: () => undefined,
    now: () => clock.now,
    log,
  });
  const count = (kind: string) => jobs.filter((j) => j.kind === kind).length;
  const idle = () => service.status().running === null && service.status().queued.length === 0;
  /** Scheduled runs are fire-and-forget: wait until the queue has stayed empty for a few turns. */
  const settle = async () => {
    for (let calm = 0, i = 0; calm < 4 && i < 2000; i += 1) {
      await new Promise((r) => setTimeout(r, 2));
      calm = idle() ? calm + 1 : 0;
    }
  };
  const getDay = (date: string) => store.get(KIND.day, date, workDaySchema);
  const getWeek = (week: string) => store.get(KIND.week, week, workWeekSchema);
  return { service, store, registry, ctx, settings, clock, jobs, fail, count, warnings, scenario, idle, settle, getDay, getWeek };
}

const at = (h: ReturnType<typeof harness>, iso: string) => void (h.clock.now = new Date(iso));

describe("service runDay", () => {
  it("captures every source and stores a provisional rating through the runner", async () => {
    const h = harness();
    await h.service.runDayNow("2026-11-12");
    const day = await h.getDay("2026-11-12");
    expect(day?.rating).toMatchObject({ rating: "meets", provisional: true, model: "haiku", areas: ["delivery"] });
    expect(day!.rating!.stale).toBeUndefined();
    expect(Object.keys(day!.coverage)).toEqual([...SOURCE_IDS]);
    expect(Object.values(day!.coverage).map((c) => c.status)).toEqual(SOURCE_IDS.map(() => "ok"));
    expect(day!.evidence.map((e) => e.source)).toEqual(expect.arrayContaining(["confluence", "memory", "fellow"]));
    expect(h.count("worklog-context")).toBe(1);
    expect(day!.meetingMinutes).toBe(60);
    expect(h.count("worklog-rate-day")).toBe(1);
    expect(h.jobs.filter((j) => j.kind !== "worklog-rate-day").every((j) => j.opts.model === "haiku")).toBe(true);
    expect(h.jobs.find((j) => j.kind === "worklog-meetings")!.prompt).toContain("America/New_York");
    const grid = await h.service.grid(4);
    expect(grid.weeks.at(-1)!.cells[3]).toMatchObject({ state: "rated", rating: "meets", provisional: true, areas: ["delivery"], evidenceCount: day!.evidence.length });
    expect(grid.timeZone).toBe("America/New_York");
  });

  it("fills the index day with areas, per-source evidence counts and coverage", async () => {
    const h = harness();
    await h.service.runDayNow("2026-11-12");
    const index = await h.service.index();
    const entry = index.days["2026-11-12"]!;
    expect(entry.areas).toEqual(["delivery"]);
    expect(entry.evidenceBySource).toMatchObject({ calendar: 1, slack: 1, jira: 1, confluence: 1, memory: 1, fellow: 1 });
    expect(entry.coverage).toEqual(Object.fromEntries(SOURCE_IDS.map((s) => [s, "ok"])));
    expect(entry.worstCoverage).toBe("ok");
  });

  it("keeps rating null and reports the error when the rating job fails", async () => {
    const h = harness();
    h.fail.add("worklog-rate-day");
    await expect(h.service.runDayNow("2026-11-12")).rejects.toThrow(/worker failed/);
    expect((await h.service.day("2026-11-12"))?.rating).toBeNull();
    expect(h.service.status().lastError?.key).toBe("day:2026-11-12");
  });

  it("rejects future dates, weekends and the days of a final week", async () => {
    const h = harness();
    await expect(h.service.runDayNow("2026-11-13")).rejects.toThrow(/future/);
    await expect(h.service.run({ kind: "day", date: "2026-11-08" })).rejects.toThrow(/weekend/);
    await expect(h.service.run({ kind: "day", date: "11/12/2026" })).rejects.toThrow(/Invalid date/);
    at(h, FRI_1805);
    await h.service.runWeekNow("2026-W46");
    await expect(h.service.runDayNow("2026-11-10")).rejects.toThrow(/final/);
  });

  it("joins a second request for the same day into one run", async () => {
    const h = harness();
    await Promise.all([h.service.runDayNow("2026-11-12"), h.service.runDayNow("2026-11-12")]);
    expect(h.count("worklog-rate-day")).toBe(1);
  });

  it("run() returns at once and the work happens in the queue", async () => {
    const h = harness();
    await h.service.run({ kind: "day", date: "2026-11-12" });
    await expect.poll(() => h.idle() && h.count("worklog-rate-day") === 1).toBe(true);
    expect((await h.service.day("2026-11-12"))?.rating?.provisional).toBe(true);
  });

  it("skips the rating model call when there is no evidence", async () => {
    const h = harness({ enabledSources: [] });
    await h.service.runDayNow("2026-11-12");
    expect(h.count("worklog-rate-day")).toBe(0);
    expect((await h.service.day("2026-11-12"))?.rating).toMatchObject({ rating: "none", provisional: true, model: null });
  });
});

describe("service runWeek", () => {
  it("captures only missing days, finalises ratings and builds the report with My notes from the addenda", async () => {
    const h = harness();
    at(h, MON_EVENING);
    await h.service.runDayNow("2026-11-09");
    const meetingsBefore = h.count("worklog-meetings");

    at(h, FRI_1805);
    const week = await h.service.runWeekNow("2026-W46");
    expect(h.count("worklog-meetings") - meetingsBefore).toBe(4); // Tue..Fri only
    expect(h.count("worklog-judge-week")).toBe(1);
    expect(h.jobs.find((j) => j.kind === "worklog-judge-week")!.opts.model).toBe("opus");
    expect(week).toMatchObject({ final: true, rating: "meets", daysWorked: 5, frameworkId: "default" });
    expect(week.areasSnapshot.map((a) => a.key)).toEqual(AREAS);
    expect(week.raiseWithManager).toHaveLength(1);
    expect(week.plan).toEqual([]);
    expect(week.ext).toEqual({});
    for (const d of weekDates("2026-W46")) {
      expect((await h.service.day(d))?.rating).toMatchObject({ provisional: false, model: "opus" });
    }
    expect((await h.service.index()).weeks["2026-W46"]).toMatchObject({ final: true, rating: "meets" });
    expect(await h.service.weekFinal("2026-W46")).toBe(true);

    await h.store.set(KIND.addenda, "2026-W46", { week: "2026-W46", myNotes: "Remember to thank Sam.", claimedWork: [], raiseWithManager: [], updatedAt: "2026-11-13T23:10:00Z" });
    const md = await h.service.weekMarkdown("2026-W46");
    expect(md.filename).toBe("2026-W46.md");
    expect(md.markdown).toContain("2026-W46");
    expect(md.markdown).toContain("Remember to thank Sam.");
    await h.service.runWeekNow("2026-W46");
    expect(h.count("worklog-meetings") - meetingsBefore).toBe(4); // nothing recaptured
    await expect(h.service.weekMarkdown("2026-W40")).rejects.toThrow(/No report/);
  });

  it("recaptures every day with recapture", async () => {
    const h = harness();
    at(h, FRI_1805);
    await h.service.runWeekNow("2026-W46");
    const before = h.count("worklog-meetings");
    await h.service.runWeekNow("2026-W46", true);
    expect(h.count("worklog-meetings") - before).toBe(5);
  });

  it("re-captures only the failed sources of a day", async () => {
    const h = harness();
    h.fail.add("worklog-slack");
    at(h, FRI_1805);
    await h.service.runWeekNow("2026-W46");
    expect((await h.service.day("2026-11-10"))?.coverage.slack?.status).toBe("failed");
    h.fail.delete("worklog-slack");
    const meetings = h.count("worklog-meetings");
    await h.service.runWeekNow("2026-W46");
    expect(h.count("worklog-meetings")).toBe(meetings);
    expect((await h.service.day("2026-11-10"))?.coverage.slack?.status).toBe("ok");
  });

  it("a failed re-capture never replaces good data", async () => {
    const h = harness();
    at(h, THU_EVENING);
    await h.service.runDayNow("2026-11-12");
    const before = (await h.service.day("2026-11-12"))!;
    h.fail.add("worklog-slack");
    h.fail.add("worklog-jira");
    await h.service.runDayNow("2026-11-12");
    const after = (await h.service.day("2026-11-12"))!;
    expect(after.coverage.slack?.status).toBe("ok");
    expect(after.coverage.jira?.status).toBe("ok");
    expect(after.evidence.filter((e) => e.source === "slack")).toHaveLength(1);
    expect(after.evidence.filter((e) => e.source === "jira")).toHaveLength(1);
    expect(after.evidence.length).toBe(before.evidence.length);
    expect(h.warnings.some((w) => w.includes("kept the previous capture"))).toBe(true);
  });

  it("leaves a mid-week report not final with provisional days", async () => {
    const h = harness();
    at(h, THU_EVENING);
    await h.service.runWeekNow("2026-W46");
    expect((await h.service.week("2026-W46"))?.final).toBe(false);
    expect((await h.service.day("2026-11-12"))?.rating?.provisional).toBe(true);
    expect(await h.service.day("2026-11-13")).toBeNull();
  });

  it("is final only from the weekly slot time on Friday", async () => {
    const h = harness();
    at(h, FRI_1630);
    await h.service.runWeekNow("2026-W46");
    expect((await h.service.week("2026-W46"))?.final).toBe(false);
    expect((await h.service.day("2026-11-13"))?.rating?.provisional).toBe(true);
    expect(await h.service.weekFinal("2026-W46")).toBe(false);
    at(h, FRI_1805);
    await h.service.runWeekNow("2026-W46");
    expect((await h.service.week("2026-W46"))?.final).toBe(true);
  });

  it("derives the final time from the weekly cron", () => {
    expect(weekEndTime("0 18 * * 5")).toBe("18:00");
    expect(weekEndTime("30 16 * * 5")).toBe("16:30");
    expect(weekEndTime("*/5 * * * 5")).toBe("18:00");
  });

  it("keeps the previous (final) ratings, marked stale, when a recapture's judgment fails", async () => {
    const h = harness();
    at(h, FRI_1805);
    await h.service.runWeekNow("2026-W46");
    h.fail.add("worklog-judge-week");
    await expect(h.service.runWeekNow("2026-W46", true)).rejects.toThrow();
    const day = await h.service.day("2026-11-10");
    expect(day?.rating).toMatchObject({ rating: "exceeds", provisional: false, stale: true });
    expect((await h.service.week("2026-W46"))?.final).toBe(true);
    expect(h.service.status().lastError?.key).toBe("week:2026-W46");
  });

  it("keeps noted / passive flags when only the notes source fails on a re-capture", async () => {
    const h = harness();
    at(h, THU_EVENING);
    h.scenario.granolaNotes = [{ title: "Design sync", start: "2026-11-12T15:05:00Z", passive: true }];
    await h.service.runDayNow("2026-11-12");
    expect((await h.service.day("2026-11-12"))?.meetings[0]).toMatchObject({ noted: true, passive: true });
    h.scenario.granolaFail = true;
    await h.service.runDayNow("2026-11-12");
    const day = await h.service.day("2026-11-12");
    expect(day?.coverage.granola?.status).toBe("ok");
    expect(day?.meetings[0]).toMatchObject({ noted: true, passive: true });
  });

  it("upgrades a pending run when a recapture request joins it", async () => {
    const h = harness();
    at(h, FRI_1805);
    await h.service.runWeekNow("2026-W46");
    const before = h.count("worklog-meetings");
    const judged = h.count("worklog-judge-week");
    await Promise.all([h.service.runWeekNow("2026-W46"), h.service.runWeekNow("2026-W46", true)]);
    expect(h.count("worklog-meetings") - before).toBe(5);
    expect(h.count("worklog-judge-week") - judged).toBe(1);
  });

  it("a re-run captures only the sources a legacy day lacks and keeps its evidence", async () => {
    const h = harness();
    at(h, FRI_1805);
    await h.service.runWeekNow("2026-W46");
    for (const date of weekDates("2026-W46")) {
      const day = (await h.getDay(date))!;
      const { confluence: _c, vault: _v, memory: _m, ...legacy } = day.coverage;
      await h.store.set(KIND.day, date, { ...day, coverage: legacy, evidence: day.evidence.filter((e) => !["confluence", "vault", "memory"].includes(e.source)) });
    }
    const before = { meetings: h.count("worklog-meetings"), slack: h.count("worklog-slack"), github: h.count("worklog-github"), context: h.count("worklog-context"), wiki: h.count("worklog-confluence") };
    await h.service.runWeekNow("2026-W46");
    expect(h.count("worklog-meetings")).toBe(before.meetings);
    expect(h.count("worklog-slack")).toBe(before.slack);
    expect(h.count("worklog-github")).toBe(before.github);
    expect(h.count("worklog-context")).toBe(before.context + 1); // one job for the whole week
    expect(h.count("worklog-confluence")).toBe(before.wiki + 1);
    const day = (await h.service.day("2026-11-10"))!;
    expect(day.coverage.confluence?.status).toBe("ok");
    expect(day.coverage.memory?.status).toBe("ok");
    expect(day.evidence.map((e) => e.source)).toEqual(expect.arrayContaining(["calendar", "jira", "slack", "confluence", "memory"]));
  });
});

describe("service scheduledTick", () => {
  it("does nothing before onboarding completes", async () => {
    const h = harness();
    h.scenario.onboarded = false;
    at(h, FRI_1805);
    await h.service.scheduledTick();
    await h.settle();
    expect(h.jobs).toEqual([]);
    expect(await h.store.getMeta(WORKLOG_DAILY_SLOT_KEY)).toBeNull();
    expect(await h.store.getMeta(WORKLOG_WEEKLY_SLOT_KEY)).toBeNull();
  });

  it("does nothing when scheduled capture is disabled", async () => {
    const h = harness({ enabled: false });
    at(h, FRI_1805);
    await h.service.scheduledTick();
    await h.settle();
    expect(h.jobs).toEqual([]);
  });

  it("on Friday runs the daily slot first, then the weekly slot once", async () => {
    const h = harness();
    at(h, FRI_1750);
    await h.service.scheduledTick();
    await h.settle();
    expect(h.count("worklog-rate-day")).toBe(1); // week not final yet: Friday gets its provisional rating
    expect(h.count("worklog-judge-week")).toBe(0);
    expect(await h.store.getMeta(WORKLOG_DAILY_SLOT_KEY)).toBe("2026-11-13 17:45");
    expect(await h.store.getMeta(WORKLOG_WEEKLY_SLOT_KEY)).toBeNull();

    at(h, FRI_1805);
    await h.service.scheduledTick();
    await h.settle();
    expect(h.count("worklog-judge-week")).toBe(1);
    expect(await h.store.getMeta(WORKLOG_WEEKLY_SLOT_KEY)).toBe("2026-11-13 18:00");
    await h.service.scheduledTick();
    await h.settle();
    expect(h.count("worklog-judge-week")).toBe(1);
    expect((await h.service.week("2026-W46"))?.final).toBe(true);
  });

  it("runs the daily slot on a weekday and stores the slot", async () => {
    const h = harness();
    at(h, THU_EVENING);
    await h.service.scheduledTick();
    await h.settle();
    expect(h.count("worklog-rate-day")).toBe(1);
    expect(await h.store.getMeta(WORKLOG_DAILY_SLOT_KEY)).toBe("2026-11-12 17:45");
    await h.service.scheduledTick();
    await h.settle();
    expect(h.count("worklog-rate-day")).toBe(1);
  });

  it("stores the slot after a failed attempt and does not retry it", async () => {
    const h = harness();
    h.fail.add("worklog-judge-week");
    at(h, FRI_1805);
    await h.service.scheduledTick();
    await h.settle();
    expect(h.count("worklog-judge-week")).toBe(1);
    expect(await h.store.getMeta(WORKLOG_WEEKLY_SLOT_KEY)).toBe("2026-11-13 18:00");
    expect(h.service.status().lastError?.key).toBe("week:2026-W46");
    await h.service.scheduledTick();
    await h.settle();
    expect(h.count("worklog-judge-week")).toBe(1);
  });

  it("the weekly run recaptures today even if it was captured earlier", async () => {
    const h = harness();
    at(h, FRI_1630);
    await h.service.runDayNow("2026-11-13");
    expect(h.count("worklog-meetings")).toBe(1);
    at(h, FRI_1805);
    await h.service.scheduledTick();
    await h.settle();
    expect(h.count("worklog-meetings")).toBe(1 + 5); // Mon-Thu new, Friday again
    expect((await h.service.week("2026-W46"))?.final).toBe(true);
  });

  it("finishes last week first when the Friday run was missed", async () => {
    const h = harness();
    at(h, THU_EVENING);
    await h.service.runDayNow("2026-11-12");
    at(h, NEXT_MON_1750);
    await h.service.scheduledTick();
    await h.settle();
    const kinds = h.jobs.map((j) => j.kind);
    expect(kinds.filter((k) => k === "worklog-judge-week")).toHaveLength(1);
    expect((await h.service.week("2026-W46"))?.final).toBe(true);
    expect(await h.service.day("2026-11-16")).not.toBeNull();
    expect(kinds.lastIndexOf("worklog-judge-week")).toBeLessThan(kinds.lastIndexOf("worklog-rate-day"));
  });

  it("two overlapping ticks queue exactly one week run (slot written before the run starts)", async () => {
    const h = harness();
    at(h, FRI_1805);
    await h.service.runDayNow("2026-11-12"); // Thursday captured earlier, so only the queue matters below
    await Promise.all([h.service.scheduledTick(), h.service.scheduledTick(), h.service.scheduledTick()]);
    expect(await h.store.getMeta(WORKLOG_WEEKLY_SLOT_KEY)).toBe("2026-11-13 18:00");
    await h.settle();
    expect(h.count("worklog-judge-week")).toBe(1);
    // A later tick, even while nothing runs, finds the slot taken.
    await h.service.scheduledTick();
    await h.settle();
    expect(h.count("worklog-judge-week")).toBe(1);
  });

  it("stops retrying a missed week's catch-up judgment after 2 attempts", async () => {
    const h = harness();
    at(h, THU_EVENING);
    await h.service.runDayNow("2026-11-12");
    h.fail.add("worklog-judge-week");
    for (const iso of ["2026-11-16T22:50:00Z", "2026-11-17T22:50:00Z", "2026-11-18T22:50:00Z"]) {
      at(h, iso);
      await h.store.setMeta(WORKLOG_DAILY_SLOT_KEY, "");
      await h.service.scheduledTick();
      await h.settle();
    }
    expect(h.count("worklog-judge-week")).toBe(2);
    expect(await h.store.getMeta(catchupKey("2026-W46"))).toBe("3");
    expect(h.warnings.some((w) => w.includes("gave up"))).toBe(true);
  });
});

describe("service index lock", () => {
  it("concurrent index writers never lose an update", async () => {
    const h = harness();
    const days = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"];
    for (const d of days) await h.service.runDayNow(d).catch(() => undefined);
    const raw = (await h.store.get(KIND.day, days[0]!, workDaySchema))!;
    // Slow the store down so unlocked read-modify-writes would interleave.
    const realSet = h.store.set.bind(h.store);
    const realGet = h.store.get.bind(h.store);
    (h.store as { get: unknown }).get = async (...a: Parameters<typeof realGet>) => {
      const v = await realGet(...a);
      await new Promise((r) => setTimeout(r, 3));
      return v;
    };
    (h.store as { set: unknown }).set = async (...a: Parameters<typeof realSet>) => {
      await new Promise((r) => setTimeout(r, 1));
      return realSet(...a);
    };
    const imports = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"].map((date) => ({ ...raw, date, evidence: [], rating: null }));
    await Promise.all([...imports.map((d) => h.service.importDay(d)), h.service.rebuildIndex(), h.service.importDay({ ...raw, date: "2026-11-09" })]);
    const index = worklogIndexSchema.parse(await realGet(KIND.index, INDEX_ID, worklogIndexSchema));
    for (const d of [...imports.map((i) => i.date), ...days]) expect(index.days[d], d).toBeDefined();
  });
});

describe("service backfill and fill_gaps", () => {
  it("queues the finished weeks oldest first and skips final ones", async () => {
    const h = harness();
    at(h, FRI_1805);
    await h.store.set(KIND.index, INDEX_ID, { version: 2, days: {}, weeks: { "2026-W44": { rating: "meets", final: true, generatedAt: "2026-11-01T00:00:00Z" } } });
    await h.service.run({ kind: "backfill", weeks: 4 });
    await expect.poll(() => h.idle() && h.count("worklog-judge-week") === 3).toBe(true);
    const order = h.jobs.filter((j) => j.kind === "worklog-judge-week").map((j) => /(\d{4}-W\d{2})/.exec(j.prompt)![1]);
    expect(order).toEqual(["2026-W42", "2026-W43", "2026-W45"]); // W46 ends today: not finished
  });

  it("includes final weeks with force and clamps the count to the limit", async () => {
    const h = harness();
    at(h, FRI_1805);
    await h.store.set(KIND.index, INDEX_ID, { version: 2, days: {}, weeks: { "2026-W45": { rating: "meets", final: true, generatedAt: "2026-11-09T00:00:00Z" } } });
    await h.service.run({ kind: "backfill", weeks: 100, force: true });
    await expect.poll(() => h.idle() && h.count("worklog-judge-week") === 40, { timeout: 20_000 }).toBe(true);
    const order = h.jobs.filter((j) => j.kind === "worklog-judge-week").map((j) => /(\d{4}-W\d{2})/.exec(j.prompt)![1]);
    expect(order.at(-1)).toBe("2026-W45");
  });

  it("fill_gaps queues weeks with missing days or no final judgment, and leaves clean weeks alone", async () => {
    const h = harness();
    at(h, THU_EVENING);
    await h.service.runWeekNow("2026-W46"); // Mon-Thu only
    at(h, FRI_1805);
    await h.service.run({ kind: "fill_gaps", weeks: 2 });
    await expect.poll(() => h.idle() && h.count("worklog-judge-week") === 3).toBe(true); // 1 from above + W45 and W46
    expect((await h.service.week("2026-W45"))?.final).toBe(true);
    expect((await h.service.week("2026-W46"))?.final).toBe(true);
    const judged = h.count("worklog-judge-week");
    await h.service.run({ kind: "fill_gaps", weeks: 2 });
    await Promise.resolve();
    expect(h.idle()).toBe(true);
    expect(h.count("worklog-judge-week")).toBe(judged);
  });
});

describe("service connector check and settings", () => {
  it("two sources that are off get off coverage, no job runs, and worstStatus ignores them", async () => {
    const h = harness();
    h.scenario.connectors = connectorCheck({ slack: { available: false, note: "not signed in" }, jira: { available: false } });
    await h.service.runDayNow("2026-11-12");
    expect(h.count("worklog-slack")).toBe(0);
    expect(h.count("worklog-jira")).toBe(0);
    const day = (await h.service.day("2026-11-12"))!;
    expect(day.coverage.slack).toEqual({ status: "off", note: "not signed in" });
    expect(day.coverage.jira?.status).toBe("off");
    expect(day.evidence.some((e) => e.source === "slack" || e.source === "jira")).toBe(false);
    expect(day.rating?.rating).toBe("meets");
    const index = await h.service.index();
    expect(index.days["2026-11-12"]!.worstCoverage).toBe("ok");
    expect(index.days["2026-11-12"]!.coverage).toMatchObject({ slack: "off", jira: "off", calendar: "ok" });
    const grid = await h.service.grid(2);
    expect(grid.weeks.at(-1)!.cells[3]!.worstCoverage).toBe("ok");
  });

  it("a week saves with off sources: nothing re-captures them and the week coverage is off", async () => {
    const h = harness();
    h.scenario.connectors = connectorCheck({ slack: { available: false }, jira: { available: false } });
    at(h, FRI_1805);
    await h.service.runWeekNow("2026-W46");
    const slackJobs = h.count("worklog-slack");
    expect(slackJobs).toBe(0);
    const week = (await h.service.week("2026-W46"))!;
    expect(week.coverage.slack?.status).toBe("off");
    expect(week.coverage.jira?.status).toBe("off");
    expect(week.final).toBe(true);
    const meetings = h.count("worklog-meetings");
    await h.service.runWeekNow("2026-W46");
    expect(h.count("worklog-meetings")).toBe(meetings);
    expect(h.count("worklog-slack")).toBe(0);
    expect(h.jobs.find((j) => j.kind === "worklog-rate-day" || j.kind === "worklog-judge-week")!.prompt).toContain("not connected");
  });

  it("sources turned off in settings are off too, and an enabled source never checked counts as enabled", async () => {
    const h = harness({ enabledSources: ["calendar", "slack"] });
    h.scenario.connectors = connectorCheck({ calendar: { available: null } });
    await h.service.runDayNow("2026-11-12");
    const day = (await h.service.day("2026-11-12"))!;
    expect(day.coverage.calendar?.status).toBe("ok");
    expect(day.coverage.slack?.status).toBe("ok");
    expect(day.coverage.github).toEqual({ status: "off", note: "turned off in settings" });
    expect(h.count("worklog-github")).toBe(0);
    expect(h.count("worklog-context")).toBe(0);
    expect(h.count("worklog-jira")).toBe(0);
  });

  it("the meetings job only asks about the enabled note sources", async () => {
    const h = harness({ enabledSources: ["calendar", "fellow"] });
    await h.service.runDayNow("2026-11-12");
    const prompt = h.jobs.find((j) => j.kind === "worklog-meetings")!.prompt;
    expect(prompt).toContain("Fellow");
    expect(prompt).not.toContain("Granola");
    expect((await h.service.day("2026-11-12"))?.coverage.granola?.status).toBe("off");
  });

  it("skips the context job when vault and memory are both off", async () => {
    const h = harness();
    h.scenario.connectors = connectorCheck({ vault: { available: false }, memory: { available: false } });
    await h.service.runDayNow("2026-11-12");
    expect(h.count("worklog-context")).toBe(0);
    const day = (await h.service.day("2026-11-12"))!;
    expect(day.coverage.vault?.status).toBe("off");
    expect(day.coverage.memory?.status).toBe("off");
    expect(day.evidence.some((e) => e.source === "memory")).toBe(false);
  });

  it("runs the context job with only the part that is on", async () => {
    const h = harness();
    h.scenario.connectors = connectorCheck({ vault: { available: false } });
    await h.service.runDayNow("2026-11-12");
    expect(h.count("worklog-context")).toBe(1);
    const day = (await h.service.day("2026-11-12"))!;
    expect(day.coverage.vault?.status).toBe("off");
    expect(day.coverage.memory?.status).toBe("ok");
  });

  it("chooses the GitHub mode from the connector check, default gh", async () => {
    const h = harness();
    await h.service.runDayNow("2026-11-12");
    const gh = h.jobs.find((j) => j.kind === "worklog-github")!;
    expect(gh.prompt).toContain("gh api graphql");
    expect(gh.prompt).not.toContain("code-host read tools");

    const m = harness();
    m.scenario.connectors = connectorCheck({ github: { available: true, mode: "mcp" } });
    await m.service.runDayNow("2026-11-12");
    const mcp = m.jobs.find((j) => j.kind === "worklog-github")!;
    expect(mcp.prompt).toContain("code-host read tools");
    expect(mcp.prompt).not.toContain("gh api graphql");
    expect(mcp.prompt).toContain("acme");
  });

  it("passes watched channels to the chat job", async () => {
    const h = harness();
    await h.service.runDayNow("2026-11-12");
    expect(h.jobs.find((j) => j.kind === "worklog-slack")!.prompt).toContain("#eng-help");
  });
});

describe("service extensions", () => {
  const extension = (over: Partial<PromptExtension> = {}): PromptExtension => ({
    id: "plan",
    dayRules: () => "EXTRA-DAY-RULE: count calibration examples.",
    weekRules: () => "EXTRA-WEEK-RULE: judge against the plan.",
    weekReplyExample: () => '"plan":[{"itemId":"p1","status":"done","note":"n","evidenceIds":[]}]',
    validateWeekExtra: (raw) => {
      if (!Array.isArray(raw.plan)) throw new Error("plan missing");
      return raw.plan;
    },
    ...over,
  });
  const planReply = [{ itemId: "p1", status: "done", note: "shipped it", evidenceIds: [] }];

  it("adds extraRules to the day and judge prompts and stores validateWeekExtra at week.ext[id]", async () => {
    const h = harness();
    h.registry.prompts.push(extension());
    h.scenario.planReply = planReply;
    at(h, FRI_1805);
    const week = await h.service.runWeekNow("2026-W46");
    const judge = h.jobs.find((j) => j.kind === "worklog-judge-week")!.prompt;
    expect(judge).toContain("EXTRA-WEEK-RULE");
    expect(judge).toContain('"plan":[{"itemId":"p1"');
    expect(week.ext.plan).toEqual(planReply);
    expect(week.plan).toEqual(planReply);
    expect((await h.service.week("2026-W46"))?.ext.plan).toEqual(planReply);

    const g = harness();
    g.registry.prompts.push(extension());
    at(g, MON_EVENING);
    await g.service.runDayNow("2026-11-09");
    expect(g.jobs.find((j) => j.kind === "worklog-rate-day")!.prompt).toContain("EXTRA-DAY-RULE");
  });

  it("keeps ext keyed by id and plan empty when the extension result is not an array", async () => {
    const h = harness();
    h.registry.prompts.push(extension({ id: "calibration", validateWeekExtra: () => ({ examples: 2 }) }));
    at(h, FRI_1805);
    const week = await h.service.runWeekNow("2026-W46");
    expect(week.ext).toEqual({ calibration: { examples: 2 } });
    expect(week.plan).toEqual([]);
  });

  it("an extension that rejects the reply fails the judgment run and keeps the stale day ratings", async () => {
    const h = harness();
    h.registry.prompts.push(extension()); // the fake judge reply has no plan key
    at(h, FRI_1805);
    await expect(h.service.runWeekNow("2026-W46")).rejects.toThrow(/plan missing/);
    expect(await h.service.week("2026-W46")).toBeNull();
  });

  it("calls a WeekHook after the week is saved, and a throwing hook does not fail the run", async () => {
    const h = harness();
    const seen: Array<{ week: string; stored: boolean }> = [];
    h.registry.weekHooks.push(
      {
        id: "bad",
        afterWeekSaved: async () => {
          throw new Error("hook exploded");
        },
      },
      {
        id: "good",
        afterWeekSaved: async (week, ctx) => {
          seen.push({ week: week.week, stored: (await ctx.store.get(KIND.week, week.week, workWeekSchema)) !== null });
        },
      },
    );
    at(h, FRI_1805);
    const week = await h.service.runWeekNow("2026-W46");
    expect(week.final).toBe(true);
    expect(seen).toEqual([{ week: "2026-W46", stored: true }]);
    expect(h.warnings.some((w) => w.includes("bad") && w.includes("hook exploded"))).toBe(true);
    expect(h.service.status().lastError).toBeNull();
  });

  it("calls a DayHook after a day is rated, and a throwing hook does not fail the run", async () => {
    const h = harness();
    const rated: string[] = [];
    h.registry.dayHooks.push(
      {
        id: "bad",
        afterDayRated: async () => {
          throw new Error("day hook exploded");
        },
      },
      { id: "good", afterDayRated: async (day) => void rated.push(`${day.date}:${day.rating?.rating}`) },
    );
    await h.service.runDayNow("2026-11-12");
    expect(rated).toEqual(["2026-11-12:meets"]);
    expect(h.warnings.some((w) => w.includes("day hook bad"))).toBe(true);
  });

  it("lets a GridContributor mutate the grid, and survives one that throws", async () => {
    const h = harness();
    h.registry.grid.push(
      {
        id: "boom",
        contribute: async () => {
          throw new Error("no");
        },
      },
      {
        id: "marker",
        contribute: async (grid) => {
          grid.lensAvailability.plan = true;
          grid.weeks.at(-1)!.markers.shipped = 3;
        },
      },
    );
    const grid = await h.service.grid(3);
    expect(grid.lensAvailability.plan).toBe(true);
    expect(grid.weeks.at(-1)!.markers.shipped).toBe(3);
    expect(grid.weeks).toHaveLength(3);
    expect((await h.service.grid()).weeks).toHaveLength(h.settings.gridWeeks);
  });
});

describe("service import and rebuildIndex", () => {
  const importedDay = (date: string): WorkDay => ({
    version: 2,
    date,
    week: "2026-W45",
    capturedAt: "2026-11-10T00:00:00Z",
    coverage: Object.fromEntries(SOURCE_IDS.map((s) => [s, s === "fellow" ? { status: "off", note: "not connected" } : ok])),
    meetings: [],
    meetingCount: 0,
    meetingMinutes: 30,
    evidence: [
      { id: "J1103-1", date, source: "jira", kind: "resolved", what: "Closed ACME-2", link: null, outcome: null, area: null },
      { id: "J1103-2", date, source: "jira", kind: "created", what: "Opened ACME-3", link: null, outcome: null, area: null },
      { id: "S1103-1", date, source: "slack", kind: "help_given", what: "Helped Sam", link: null, outcome: null, area: null },
    ],
    rating: { rating: "exceeds", provisional: false, reason: "Great", summary: "s", areas: ["delivery", "collaboration"], evidenceIds: ["J1103-1"], ratedAt: "2026-11-10T00:00:00Z", model: null },
  });

  it("importDay + importWeek + rebuildIndex give index days with areas, evidenceBySource and coverage", async () => {
    const h = harness();
    // Seed through the store (like a migration would), then rebuild.
    const day = importedDay("2026-11-03");
    await h.service.importDay(day);
    const week: WorkWeek = workWeekSchema.parse({
      version: 2,
      week: "2026-W45",
      from: "2026-11-02",
      to: "2026-11-06",
      generatedAt: "2026-11-07T00:00:00Z",
      model: null,
      final: true,
      rating: "exceeds",
      ratingReason: "r",
      threeLines: ["a"],
      days: [],
      daysWorked: 1,
      scorecard: [],
      meetings: { count: 0, hours: 0, pctOfWeek: 0, passiveCount: 0, topSinks: [] },
      reflection: { goodWeek: true, text: "t" },
      coverage: day.coverage,
    });
    await h.service.importWeek(week);

    // Wipe the index, then rebuild it from the stored records.
    await h.store.delete(KIND.index, INDEX_ID);
    expect((await h.service.index()).days).toEqual({});
    await h.service.rebuildIndex();
    const index = worklogIndexSchema.parse(await h.store.get(KIND.index, INDEX_ID, worklogIndexSchema));
    expect(index.days["2026-11-03"]).toMatchObject({
      rating: "exceeds",
      provisional: false,
      meetingMinutes: 30,
      evidenceCount: 3,
      worstCoverage: "ok",
      areas: ["delivery", "collaboration"],
      evidenceBySource: { jira: 2, slack: 1 },
    });
    expect(index.days["2026-11-03"]!.coverage).toMatchObject({ fellow: "off", jira: "ok" });
    expect(index.weeks["2026-W45"]).toMatchObject({ rating: "exceeds", final: true });
    expect(await h.service.weekFinal("2026-W45")).toBe(true);
    const grid = await h.service.grid(3);
    expect(grid.weeks.find((w) => w.week === "2026-W45")!.cells[1]).toMatchObject({ state: "rated", rating: "exceeds", areas: ["delivery", "collaboration"], evidenceBySource: { jira: 2, slack: 1 } });
    expect(grid.lensAvailability.area).toBe(true);
  });

  it("importDay updates the index without running hooks, and replayWeekHooks runs the week hooks oldest first", async () => {
    const h = harness();
    const dayCalls: string[] = [];
    const weekCalls: string[] = [];
    h.registry.dayHooks.push({ id: "d", afterDayRated: async (d) => void dayCalls.push(d.date) });
    h.registry.weekHooks.push({ id: "w", afterWeekSaved: async (w) => void weekCalls.push(w.week) });
    await h.service.importDay(importedDay("2026-11-03"));
    expect((await h.service.index()).days["2026-11-03"]!.areas).toEqual(["delivery", "collaboration"]);
    expect(dayCalls).toEqual([]);
    const base = {
      version: 2,
      from: "2026-11-02",
      to: "2026-11-06",
      generatedAt: "2026-11-07T00:00:00Z",
      model: null,
      final: true,
      rating: "meets",
      ratingReason: "r",
      threeLines: ["a"],
      days: [],
      daysWorked: 1,
      scorecard: [],
      meetings: { count: 0, hours: 0, pctOfWeek: 0, passiveCount: 0, topSinks: [] },
      reflection: { goodWeek: true, text: "t" },
      coverage: {},
    };
    await h.service.importWeek(workWeekSchema.parse({ ...base, week: "2026-W45" }));
    await h.service.importWeek(workWeekSchema.parse({ ...base, week: "2026-W44" }));
    expect(weekCalls).toEqual([]);
    expect(await h.service.replayWeekHooks()).toBe(2);
    expect(weekCalls).toEqual(["2026-W44", "2026-W45"]);
    expect(await h.service.replayWeekHooks(["2026-W45", "2026-W30"])).toBe(1);
  });
});

describe("service identity in capture prompts", () => {
  it("passes the profile's name and email to every capture job", async () => {
    const h = harness();
    await h.store.set(KIND.profile, "active", profileSchema.parse({ identity: { name: "Alex Doe", email: "alex@acme.test", handles: { slack: "U0ALEX", github: "alexdoe" } } }));
    await h.service.runDayNow("2026-11-12");
    for (const kind of ["worklog-meetings", "worklog-slack", "worklog-jira", "worklog-confluence", "worklog-context"]) {
      const prompt = h.jobs.find((j) => j.kind === kind)?.prompt;
      expect(prompt, kind).toContain("Alex Doe");
      expect(prompt, kind).toContain("alex@acme.test");
    }
    expect(h.jobs.find((j) => j.kind === "worklog-slack")!.prompt).toContain("U0ALEX");
    // the gh-script github job is the script verbatim: it runs as the signed-in login, so it carries no identity line
    expect(h.jobs.find((j) => j.kind === "worklog-github")!.prompt).not.toContain("Alex Doe");
  });
  it("adds no identity line without a profile", async () => {
    const h = harness();
    await h.service.runDayNow("2026-11-12");
    expect(h.jobs.some((j) => j.prompt.includes("The user is "))).toBe(false);
  });
});
