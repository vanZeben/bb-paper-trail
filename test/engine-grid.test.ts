import { describe, expect, it } from "vitest";
import { buildGrid } from "../lib/engine/grid";
import type { WorklogIndex, WorklogStatus } from "../lib/types";

const status: WorklogStatus = { running: null, queued: [], lastError: null };
const areas = [{ key: "delivery", label: "Delivery" }, { key: "mentoring", label: "Mentoring" }];
const opts = { areas, timeZone: "America/New_York", workdayHours: 8 };
const index: WorklogIndex = {
  version: 2,
  days: {
    "2026-11-09": { rating: "exceeds", provisional: false, reason: "great", meetingMinutes: 90, evidenceCount: 5, worstCoverage: "ok", areas: ["delivery", "mentoring"], evidenceBySource: { github: 3, slack: 2 }, coverage: { github: "ok", slack: "ok" } },
    "2026-11-10": { rating: "meets", provisional: true, reason: "ok", meetingMinutes: 0, evidenceCount: 2, worstCoverage: "partial", areas: [], evidenceBySource: {}, coverage: {} },
    "2026-11-11": { rating: null, provisional: false, reason: null, meetingMinutes: 30, evidenceCount: 1, worstCoverage: "failed", areas: [], evidenceBySource: {}, coverage: {} },
  },
  weeks: { "2026-W46": { rating: "meets", final: false, generatedAt: "x" } },
};

describe("buildGrid", () => {
  const grid = buildGrid(index, "2026-11-12", 26, status, opts);
  it("has 26 columns, newest last, 5 cells each", () => {
    expect(grid.weeks).toHaveLength(26);
    expect(grid.currentWeek).toBe("2026-W46");
    expect(grid.weeks.at(-1)!.week).toBe("2026-W46");
    expect(grid.weeks[0]!.week).toBe("2026-W21");
    expect(grid.weeks.every((w) => w.cells.length === 5)).toBe(true);
    expect(grid.weeks.at(-1)!.label).toBe("46");
  });
  it("derives cell states", () => {
    const cells = grid.weeks.at(-1)!.cells;
    expect(cells.map((c) => c.state)).toEqual(["rated", "rated", "unrated", "empty", "future"]);
    expect(cells[0]).toMatchObject({ rating: "exceeds", provisional: false, meetingHours: 1.5, worstCoverage: "ok" });
    expect(cells[1]).toMatchObject({ provisional: true, worstCoverage: "partial" });
    expect(cells[2]).toMatchObject({ rating: null, worstCoverage: "failed" });
    expect(cells[4]).toMatchObject({ rating: null, meetingHours: null });
    expect(grid.weeks.at(-1)).toMatchObject({ rating: "meets", final: false });
    expect(grid.weeks.at(-2)).toMatchObject({ rating: null, final: false });
  });
  it("labels the first column and every month change", () => {
    const labels = grid.weeks.map((w) => w.monthLabel);
    expect(labels[0]).toBe("May");
    expect(labels.filter((l) => l !== null)).toEqual(["May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov"]);
  });
  it("echoes areas, zone and workday hours", () => {
    expect(grid.areas).toEqual(areas);
    expect(grid.timeZone).toBe("America/New_York");
    expect(grid.workdayHours).toBe(8);
  });
});

describe("base lens fields", () => {
  const cells = buildGrid(index, "2026-11-12", 2, status, opts).weeks.at(-1)!.cells;
  it("fills rating, areas, evidence and coverage from the index day", () => {
    expect(cells[0]).toMatchObject({
      aiRating: "exceeds",
      overridden: false,
      planAdvanced: null,
      areas: ["delivery", "mentoring"],
      evidenceCount: 5,
      evidenceBySource: { github: 3, slack: 2 },
      coverage: { github: "ok", slack: "ok" },
    });
    expect(cells[2]).toMatchObject({ aiRating: null, evidenceCount: 1 });
    expect(cells[3]).toMatchObject({ aiRating: null, areas: [], evidenceCount: 0, meetingPct: null });
  });
  it("sets meetingPct = meetingMinutes / 60 / workdayHours * 100", () => {
    expect(cells[0]!.meetingPct).toBeCloseTo(18.75, 6);
    expect(cells[1]!.meetingPct).toBe(0);
    expect(cells[2]!.meetingPct).toBeCloseTo(6.25, 6);
    expect(buildGrid(index, "2026-11-12", 1, status, { ...opts, workdayHours: 6 }).weeks[0]!.cells[0]!.meetingPct).toBeCloseTo(25, 6);
    expect(buildGrid(index, "2026-11-12", 1, status, { ...opts, workdayHours: 0 }).weeks[0]!.cells[0]!.meetingPct).toBeNull();
  });
  it("starts every week with default markers", () => {
    expect(buildGrid(index, "2026-11-12", 3, status, opts).weeks.every((w) => w.markers.guardrail === null && w.markers.shipped === 0 && w.markers.planHitRate === null)).toBe(true);
  });
});

describe("lensAvailability", () => {
  it("has area only when some day has areas; plan is off until a contributor enables it", () => {
    expect(buildGrid(index, "2026-11-12", 4, status, opts).lensAvailability).toEqual({ rating: true, area: true, meeting: true, evidence: true, plan: false });
    const noAreas: WorklogIndex = { ...index, days: Object.fromEntries(Object.entries(index.days).map(([d, v]) => [d, { ...v, areas: [] }])) };
    expect(buildGrid(noAreas, "2026-11-12", 4, status, opts).lensAvailability.area).toBe(false);
    expect(buildGrid({ version: 2, days: {}, weeks: {} }, "2026-11-12", 4, status, opts).lensAvailability.area).toBe(false);
  });
});

describe("off sources", () => {
  const day = (worstCoverage: "ok" | "off" | "failed", coverage: Record<string, "ok" | "partial" | "failed" | "off">): WorklogIndex["days"][string] => ({
    rating: "meets", provisional: false, reason: "r", meetingMinutes: 0, evidenceCount: 1, worstCoverage, areas: [], evidenceBySource: {}, coverage,
  });
  const idx: WorklogIndex = {
    version: 2,
    days: {
      "2026-11-09": day("ok", { github: "ok", fellow: "off", vault: "off" }),
      "2026-11-10": day("off", { github: "off", fellow: "off" }),
      "2026-11-11": day("failed", { github: "ok", slack: "failed", fellow: "off" }),
    },
    weeks: {},
  };
  const cells = buildGrid(idx, "2026-11-13", 1, status, opts).weeks[0]!.cells;
  it("never count towards worstCoverage", () => {
    expect(cells[0]!.worstCoverage).toBe("ok");
    expect(cells[1]!.worstCoverage).toBe("ok");
    expect(cells[2]!.worstCoverage).toBe("failed");
  });
  it("still show as off in the per-source coverage", () => {
    expect(cells[0]!.coverage).toEqual({ github: "ok", fellow: "off", vault: "off" });
  });
});
