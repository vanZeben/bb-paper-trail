import { describe, expect, test } from "vitest";
import type { GridCell, WorkDay } from "../lib/types";
import { areaLabel, cellStyle, cellTitle, coverageGlyph, formatTime, highlights, isBusyKey, isWeekKey, meetingPctOfDay, runningLine, weekdayLabel } from "../components/graph/helpers";
import { cellLook, type LensCtx } from "../components/graph/lenses";

const cell = (over: Partial<GridCell>): GridCell => ({
  date: "2026-11-10", state: "rated", rating: "meets", provisional: false, reason: null, meetingHours: 2.5, worstCoverage: "ok",
  aiRating: null, overridden: false, areas: [], meetingPct: null, evidenceCount: 0, evidenceBySource: {}, planAdvanced: null, coverage: {},
  ...over,
});
const ctx: LensCtx = { areas: [{ key: "delivery", label: "Delivery" }], workdayHours: 7.5, today: "2026-11-10" };

describe("graph helpers", () => {
  test("rated cells get an inline colour; provisional ones fade with a dashed outline", () => {
    expect(cellStyle(cell({})).style.backgroundColor).toBe("#15803d");
    expect(cellStyle(cell({ rating: "exceeds" })).style.backgroundColor).toBe("#a3e635");
    const prov = cellStyle(cell({ rating: "needs_improvement", provisional: true }));
    expect(prov.style.backgroundColor).toBe("#f97316");
    expect(prov.className).toContain("opacity-50");
    expect(prov.className).toContain("outline-dashed");
  });
  test("empty, unrated and future cells", () => {
    expect(cellStyle(cell({ state: "empty", rating: null })).className).toBe("bg-muted");
    expect(cellStyle(cell({ state: "unrated", rating: null })).className).toContain("outline-dashed");
    expect(cellStyle(cell({ state: "future", rating: null })).className).toContain("border-dashed");
  });
  test("the rating lens is today's cell look", () => {
    for (const c of [cell({}), cell({ provisional: true }), cell({ state: "empty", rating: null }), cell({ state: "future", rating: null })]) {
      expect(cellLook("rating", c, ctx)).toEqual(cellStyle(c));
    }
  });
  test("titles", () => {
    expect(cellTitle(cell({}))).toBe("2026-11-10 · Meets · 2.5h meetings");
    expect(cellTitle(cell({ provisional: true }))).toContain("(provisional)");
    expect(cellTitle(cell({ state: "empty", rating: null, meetingHours: null }))).toBe("2026-11-10 · no data");
    expect(cellTitle(cell({ state: "future", rating: null }))).toContain("upcoming");
  });
  test("an overridden title names the AI rating", () => {
    expect(cellTitle(cell({ rating: "exceeds", aiRating: "meets", overridden: true }))).toContain("Exceeds");
    expect(cellTitle(cell({ rating: "exceeds", aiRating: "meets", overridden: true }))).toContain("AI said Meets");
  });
  test("week key validation and labels", () => {
    expect(isWeekKey("2026-W46")).toBe(true);
    expect(isWeekKey("2026-46")).toBe(false);
    expect(isWeekKey("2026-W60")).toBe(false);
    expect(weekdayLabel("2026-11-10")).toContain("Tuesday");
    expect(coverageGlyph("partial")).toBe("⚠");
    expect(coverageGlyph("off")).toBe("–");
  });
  test("status helpers", () => {
    const status = { running: { key: "week:2026-W46", startedAt: "x", step: "judging" }, queued: ["day:2026-11-10"], lastError: null };
    expect(runningLine(status)).toBe("week:2026-W46 · judging");
    expect(isBusyKey(status, "day:2026-11-10")).toBe(true);
    expect(isBusyKey(status, "week:2026-W45")).toBe(false);
    expect(runningLine({ ...status, running: null })).toBeNull();
  });
  test("times format in the given zone", () => {
    const iso = "2026-11-10T16:00:00Z";
    expect(formatTime(iso, "America/New_York")).toBe("11:00 AM");
    expect(formatTime(iso, "Asia/Tokyo")).toBe("1:00 AM");
    expect(formatTime(iso, "UTC")).toBe("4:00 PM");
    expect(formatTime(iso, "Not/AZone")).toContain("UTC");
    expect(formatTime("garbage", "UTC")).toBe("");
    expect(formatTime(null, "UTC")).toBe("");
  });
  test("meeting share uses the configured workday", () => {
    expect(meetingPctOfDay(180, 6)).toBe(50);
    expect(meetingPctOfDay(240, 8)).toBe(50);
    expect(meetingPctOfDay(60, 0)).toBe(0);
  });
  test("area labels come from the payload, falling back to the key", () => {
    expect(areaLabel(ctx.areas, "delivery")).toBe("Delivery");
    expect(areaLabel(ctx.areas, "gone")).toBe("gone");
  });
  test("highlights put cited evidence first and drop low-signal kinds", () => {
    const e = (id: string, kind: string) => ({ id, date: "2026-11-10", source: "calendar", kind, what: id, link: null, outcome: null, area: null });
    const day = {
      evidence: [e("C1110-1", "meeting"), e("G1110-1", "pr_merged"), e("G1110-2", "passive"), e("J1110-1", "ticket")],
      rating: { evidenceIds: ["C1110-1"] },
    } as unknown as WorkDay;
    expect(highlights(day).map((x) => x.id)).toEqual(["C1110-1", "G1110-1", "J1110-1"]);
  });
});
