import { describe, expect, it } from "vitest";
import { dayBounds } from "../lib/engine/dates";
import { matchNotes, mergedMinutes, weekMeetingStats } from "../lib/engine/meetings";
import type { WorkDay, WorkMeeting } from "../lib/types";

const at = (hhmm: string, date = "2026-11-09") => `${date}T${hhmm}:00-05:00`;
const iv = (a: string, b: string) => ({ start: at(a), end: at(b) });

describe("mergedMinutes", () => {
  it("sums disjoint, merges overlapping, nested and touching intervals", () => {
    expect(mergedMinutes([])).toBe(0);
    expect(mergedMinutes([iv("09:00", "10:00"), iv("11:00", "11:30")])).toBe(90);
    expect(mergedMinutes([iv("09:00", "10:00"), iv("09:30", "10:30")])).toBe(90);
    expect(mergedMinutes([iv("09:00", "12:00"), iv("10:00", "11:00")])).toBe(180);
    expect(mergedMinutes([iv("09:00", "10:00"), iv("10:00", "11:00")])).toBe(120);
  });

  it("clips to the day window", () => {
    const bounds = dayBounds("2026-11-09", "America/New_York");
    expect(mergedMinutes([{ start: "2026-11-08T23:00:00-05:00", end: "2026-11-09T01:00:00-05:00" }], bounds)).toBe(60);
    expect(mergedMinutes([{ start: "2026-11-08T10:00:00-05:00", end: "2026-11-08T11:00:00-05:00" }], bounds)).toBe(0);
  });
});

const meeting = (over: Partial<WorkMeeting>): WorkMeeting => ({
  id: "C1109-1", title: "Design review", start: "2026-11-09T19:00:00.000Z", end: "2026-11-09T20:00:00.000Z", minutes: 60,
  response: "needsAction", attendees: 5, noted: false, passive: null, ...over,
});

describe("matchNotes", () => {
  it("matches by start time within 20 minutes, else by normalised title", () => {
    const meetings = [meeting({ id: "C1109-1" }), meeting({ id: "C1109-2", title: "Design: API gateway", start: "2026-11-09T21:00:00.000Z" }), meeting({ id: "C1109-3", title: "1:1", start: "2026-11-09T22:00:00.000Z" })];
    const out = matchNotes(meetings, [
      { title: "whatever", start: "2026-11-09T19:10:00.000Z", passive: false },
      { title: "design api gateway", start: null, passive: true },
    ]);
    expect(out.map((m) => [m.noted, m.passive])).toEqual([[true, false], [true, true], [false, null]]);
  });
});

function day(date: string, meetingMinutes: number, meetings: WorkMeeting[]): WorkDay {
  return { version: 2, date, week: "2026-W46", capturedAt: "", coverage: {} as WorkDay["coverage"], meetings, meetingCount: meetings.length, meetingMinutes, evidence: [], rating: null };
}

describe("weekMeetingStats", () => {
  const days = [day("2026-11-09", 120, [meeting({ minutes: 60 }), meeting({ minutes: 90, title: "Standup", passive: true })]), day("2026-11-10", 60, [meeting({ minutes: 60, passive: true })])];
  it("computes count, hours, percent over days worked, passive and sinks", () => {
    const s = weekMeetingStats(days, 3, 8);
    expect(s).toMatchObject({ count: 3, hours: 3, pctOfWeek: 13, passiveCount: 2 });
    expect(s.topSinks[0]).toEqual({ title: "Design review", hours: 2 });
  });
  it("uses the number of days worked in the denominator", () => {
    expect(weekMeetingStats(days, 5, 8).pctOfWeek).toBe(8);
    expect(weekMeetingStats(days, 0, 8).pctOfWeek).toBe(38);
  });
});
