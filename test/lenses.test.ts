import { describe, expect, test } from "vitest";
import type { GridCell, WeekMarkers } from "../lib/types";
import { DASHED } from "../components/graph/helpers";
import {
  areaSlot, cellLook, evidenceBin, legendItems, LENS_CSS, LENSES, lensDisabledNote, meetingBin, parseLens, planBin, type LensCtx,
} from "../components/graph/lenses";
import { hasMarkers, weekMarkerItems } from "../components/graph/markers";
import { cellTip, weekTip } from "../components/graph/tooltip";
import { summarise } from "../components/graph/summary";

const cell = (over: Partial<GridCell>): GridCell => ({
  date: "2026-11-10", state: "rated", rating: "meets", provisional: false, reason: null, meetingHours: 2.5, worstCoverage: "ok",
  aiRating: "meets", overridden: false, areas: [], meetingPct: 30, evidenceCount: 5, evidenceBySource: { github: 3, jira: 2 }, planAdvanced: null, coverage: { github: "ok", slack: "off" },
  ...over,
});
const areas = Array.from({ length: 10 }, (_, i) => ({ key: `a${i}`, label: `Area ${i}` }));
const ctx: LensCtx = { areas, workdayHours: 7.5, today: "2026-11-10" };
const markers = (over: Partial<WeekMarkers>): WeekMarkers => ({ guardrail: null, guardrailCount: 0, drift: null, shipped: 0, needClosure: 0, planHitRate: null, ...over });

describe("bins", () => {
  test("meeting load boundaries belong to the higher bin", () => {
    expect([0, 19.9, 20, 39.9, 40, 59.9, 60, 79.9, 80, 100, 130].map(meetingBin)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 4]);
  });
  test("evidence bins: 0, 1-3, 4-7, 8-14, 15+", () => {
    expect([0, 1, 3, 4, 7, 8, 14, 15, 99].map(evidenceBin)).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4]);
  });
  test("plan bins top out at 4+", () => {
    expect([0, 1, 2, 3, 4, 9].map(planBin)).toEqual([0, 1, 2, 3, 4, 4]);
  });
  test("area slots follow framework order and fold past eight", () => {
    expect(areaSlot(areas, "a0")).toBe(0);
    expect(areaSlot(areas, "a7")).toBe(7);
    expect(areaSlot(areas, "a8")).toBe(8);
    expect(areaSlot(areas, "gone")).toBe(8);
  });
});

describe("cellLook per lens and state", () => {
  test("future and empty cells look the same in every lens", () => {
    for (const { id } of LENSES) {
      expect(cellLook(id, cell({ state: "future", rating: null }), ctx).className).toContain("border-dashed");
      expect(cellLook(id, cell({ state: "empty", rating: null, meetingPct: null, evidenceCount: 0 }), ctx)).toEqual({ className: "bg-muted", style: {} });
    }
  });
  test("provisional fades with a dashed outline in every lens", () => {
    for (const lens of ["rating", "area", "meeting", "evidence", "plan"] as const) {
      const look = cellLook(lens, cell({ provisional: true, areas: ["a1"], planAdvanced: 1 }), ctx);
      expect(look.className).toContain("opacity-50");
      expect(look.className).toContain(DASHED);
    }
  });
  test("rating: overridden cells get the corner glyph and show the effective rating", () => {
    const look = cellLook("rating", cell({ rating: "exceeds", aiRating: "meets", overridden: true }), ctx);
    expect(look.glyph).toBe("corner");
    expect(look.style.backgroundColor).toBe("#a3e635");
    expect(cellLook("rating", cell({}), ctx).glyph).toBeUndefined();
  });
  test("rating: unrated is muted and dashed", () => {
    const look = cellLook("rating", cell({ state: "unrated", rating: null }), ctx);
    expect(look.className).toContain("bg-muted");
    expect(look.className).toContain(DASHED);
  });
  test("area: dominant area colour, dot when several areas", () => {
    expect(cellLook("area", cell({ areas: ["a2"] }), ctx)).toEqual({ className: "", style: { backgroundColor: "var(--rc-area-2)" } });
    const multi = cellLook("area", cell({ areas: ["a1", "a2"] }), ctx);
    expect(multi.style.backgroundColor).toBe("var(--rc-area-1)");
    expect(multi.glyph).toBe("dot");
    expect(cellLook("area", cell({ areas: [] }), ctx).className).toBe("bg-muted");
    expect(cellLook("area", cell({ areas: ["a9"] }), ctx).style.backgroundColor).toBe("var(--rc-area-8)");
  });
  test("area: an unrated day with no areas is muted and dashed", () => {
    expect(cellLook("area", cell({ state: "unrated", rating: null, areas: [] }), ctx).className).toContain(DASHED);
  });
  test("meeting: ramp by percentage, no value is muted", () => {
    expect(cellLook("meeting", cell({ meetingPct: 19.9 }), ctx).style.backgroundColor).toBe("var(--rc-meeting-0)");
    expect(cellLook("meeting", cell({ meetingPct: 20 }), ctx).style.backgroundColor).toBe("var(--rc-meeting-1)");
    expect(cellLook("meeting", cell({ meetingPct: 85 }), ctx).style.backgroundColor).toBe("var(--rc-meeting-4)");
    expect(cellLook("meeting", cell({ meetingPct: null }), ctx).className).toBe("bg-muted");
  });
  test("evidence: a captured day with no evidence still gets the lowest step", () => {
    expect(cellLook("evidence", cell({ evidenceCount: 0 }), ctx).style.backgroundColor).toBe("var(--rc-evidence-0)");
    expect(cellLook("evidence", cell({ evidenceCount: 15 }), ctx).style.backgroundColor).toBe("var(--rc-evidence-4)");
    expect(cellLook("evidence", cell({ state: "unrated", rating: null, evidenceCount: 8 }), ctx).style.backgroundColor).toBe("var(--rc-evidence-3)");
  });
  test("plan: ramp by items advanced, null is muted", () => {
    expect(cellLook("plan", cell({ planAdvanced: 0 }), ctx).style.backgroundColor).toBe("var(--rc-plan-0)");
    expect(cellLook("plan", cell({ planAdvanced: 5 }), ctx).style.backgroundColor).toBe("var(--rc-plan-4)");
    expect(cellLook("plan", cell({ planAdvanced: null }), ctx).className).toBe("bg-muted");
  });
});

describe("lens availability, persistence and legend", () => {
  const all = { rating: true, area: true, meeting: true, evidence: true, plan: false };
  test("plan is disabled with 'no plan yet'", () => {
    expect(lensDisabledNote("plan", all)).toBe("no plan yet");
    expect(lensDisabledNote("area", all)).toBeNull();
    expect(lensDisabledNote("area", { ...all, area: false })).toBe("not available yet");
  });
  test("a stored lens falls back to rating when unknown or unavailable", () => {
    expect(parseLens("area", all)).toBe("area");
    expect(parseLens("plan", all)).toBe("rating");
    expect(parseLens("nonsense", all)).toBe("rating");
    expect(parseLens(null, all)).toBe("rating");
  });
  test("area legend lists framework areas; ramps list five bins", () => {
    expect(legendItems("area", areas.slice(0, 3)).map((i) => i.label)).toEqual(["Area 0", "Area 1", "Area 2"]);
    expect(legendItems("area", areas).at(-1)?.label).toBe("Other areas");
    expect(legendItems("meeting", areas)).toHaveLength(5);
    expect(legendItems("rating", areas)).toEqual([]);
  });
  test("the stylesheet defines every variable in both themes", () => {
    for (const name of ["--rc-area-8", "--rc-meeting-4", "--rc-evidence-0", "--rc-plan-3"]) expect(LENS_CSS.split(name).length).toBe(3);
    expect(LENS_CSS).toContain(".dark .rc-viz");
  });
});

describe("markers", () => {
  test("guardrail and drift take the places; the badge needs room", () => {
    const both = weekMarkerItems(markers({ guardrail: "warning", guardrailCount: 2, drift: "off", shipped: 3 }));
    expect(both.guardrail).toEqual({ severity: "warning", count: 2 });
    expect(both.drift).toBe("off");
    expect(both.badge).toBeNull();
    expect(weekMarkerItems(markers({ drift: "watch", shipped: 1 })).badge).toEqual({ shipped: 1, needClosure: 0 });
    expect(weekMarkerItems(markers({ needClosure: 2 })).badge).toEqual({ shipped: 0, needClosure: 2 });
    expect(weekMarkerItems(markers({})).badge).toBeNull();
  });
  test("hasMarkers", () => {
    expect(hasMarkers(markers({}))).toBe(false);
    expect(hasMarkers(markers({ drift: "watch" }))).toBe(true);
  });
});

describe("tooltips", () => {
  test("cell tooltip carries date, rating with the AI value, areas, meetings, evidence by source and coverage glyphs", () => {
    const tip = cellTip(cell({ rating: "exceeds", aiRating: "meets", overridden: true, areas: ["a1", "a2"], meetingPct: 33.3, planAdvanced: 2 }), ctx);
    const text = tip.rows.map((r) => `${r.label}: ${r.value}`).join("\n");
    expect(tip.title).toContain("Tuesday");
    expect(text).toContain("Exceeds · AI said Meets");
    expect(text).toContain("Area 1, Area 2");
    expect(text).toContain("2.5h · 33% of the day");
    expect(text).toContain("5 (github 3, jira 2)");
    expect(text).toContain("github ✓");
    expect(text).toContain("slack –");
    expect(text).toContain("2 items advanced");
  });
  test("future and empty cells", () => {
    expect(cellTip(cell({ state: "future", rating: null }), ctx).rows).toEqual([{ label: "Status", value: "Upcoming" }]);
    expect(cellTip(cell({ state: "empty", rating: null, meetingHours: null, coverage: {} }), ctx).rows).toEqual([{ label: "Rating", value: "No data" }]);
  });
  test("week tooltip lists every marker", () => {
    const week = { week: "2026-W46", from: "2026-11-09", label: "46", monthLabel: null, rating: "meets", final: true, cells: [], markers: markers({ guardrail: "breach", guardrailCount: 2, drift: "watch", shipped: 3, needClosure: 1, planHitRate: 0.5 }) } as const;
    const text = weekTip(week as never).rows.map((r) => `${r.label}: ${r.value}`).join("\n");
    expect(text).toContain("Guardrails: 2 open · worst: breach");
    expect(text).toContain("Time drift: watch");
    expect(text).toContain("Shipped: 3");
    expect(text).toContain("Need closure: 1");
    expect(text).toContain("Plan hit rate: 50%");
  });
});

describe("summary strip", () => {
  test("counts captured days, shares, averages and agreement", () => {
    const week = (cells: GridCell[]) => ({ week: "w", from: "x", label: "1", monthLabel: null, rating: null, final: true, cells, markers: markers({}) });
    const s = summarise(
      [
        week([cell({ rating: "exceeds", meetingPct: 10, evidenceCount: 4 }), cell({ rating: "needs_improvement", meetingPct: 30, evidenceCount: 2 }), cell({ state: "unrated", rating: null, meetingPct: null, evidenceCount: 1 })]),
        week([cell({ state: "empty", rating: null }), cell({ state: "future", rating: null, evidenceCount: 0 })]),
      ],
      { reviewed: 4, confirmed: 3, overridden: 1, agreementRate: 0.75, raised: 1, lowered: 0, unreviewed: 5 },
    );
    expect(s).toMatchObject({ daysCaptured: 3, ratedDays: 2, exceedsMeetsShare: 0.5, avgMeetingPct: 20, evidenceItems: 7, agreementRate: 0.75, reviewed: 4 });
    expect(summarise([], null)).toMatchObject({ daysCaptured: 0, exceedsMeetsShare: null, avgMeetingPct: null, agreementRate: null });
  });
});
