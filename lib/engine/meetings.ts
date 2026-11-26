/** meetings.ts — pure meeting maths: merged hours, meeting-note matching, week stats. */
import type { WorkDay, WorkMeeting, WeekMeetings } from "../types";

/** Merge overlapping/touching intervals, optionally clip to a window, and return the total whole minutes. */
export function mergedMinutes(intervals: ReadonlyArray<{ start: string; end: string }>, clip?: { start: Date; end: Date }): number {
  const spans: Array<[number, number]> = [];
  for (const { start, end } of intervals) {
    let s = Date.parse(start);
    let e = Date.parse(end);
    if (Number.isNaN(s) || Number.isNaN(e)) continue;
    if (clip) {
      s = Math.max(s, clip.start.getTime());
      e = Math.min(e, clip.end.getTime());
    }
    if (e > s) spans.push([s, e]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cur: [number, number] | null = null;
  for (const span of spans) {
    if (cur !== null && span[0] <= cur[1]) cur[1] = Math.max(cur[1], span[1]);
    else {
      if (cur !== null) total += cur[1] - cur[0];
      cur = [span[0], span[1]];
    }
  }
  if (cur !== null) total += cur[1] - cur[0];
  return Math.round(total / 60_000);
}

const normTitle = (title: string): string => title.toLowerCase().replace(/[^a-z0-9]/g, "");
const MATCH_WINDOW_MS = 20 * 60_000;

/** Mark which meetings have a meeting note (by start time within 20 min, else by normalised title) and whether the user only attended. */
export function matchNotes(meetings: WorkMeeting[], notes: ReadonlyArray<{ title: string; start: string | null; passive: boolean }>): WorkMeeting[] {
  const used = new Set<number>();
  return meetings.map((meeting) => {
    const start = Date.parse(meeting.start);
    const byTime = notes.findIndex((n, i) => !used.has(i) && n.start !== null && !Number.isNaN(Date.parse(n.start)) && Math.abs(Date.parse(n.start) - start) <= MATCH_WINDOW_MS);
    const at = byTime >= 0 ? byTime : notes.findIndex((n, i) => !used.has(i) && normTitle(n.title) !== "" && normTitle(n.title) === normTitle(meeting.title));
    if (at < 0) return { ...meeting, noted: false, passive: null };
    used.add(at);
    return { ...meeting, noted: true, passive: notes[at]!.passive };
  });
}

/** Week meeting numbers: count, merged hours (1 decimal), % of the worked days, passive count, top 5 titles by raw minutes. */
export function weekMeetingStats(days: readonly WorkDay[], daysWorked: number, workdayHours: number): WeekMeetings {
  const count = days.reduce((sum, d) => sum + d.meetingCount, 0);
  const hours = Math.round((days.reduce((sum, d) => sum + d.meetingMinutes, 0) / 60) * 10) / 10;
  const denominator = Math.max(1, daysWorked) * workdayHours;
  const pctOfWeek = denominator > 0 ? Math.round((100 * hours) / denominator) : 0;
  const passiveCount = days.reduce((sum, d) => sum + d.meetings.filter((m) => m.passive === true).length, 0);
  const byTitle = new Map<string, number>();
  for (const day of days) for (const m of day.meetings) byTitle.set(m.title, (byTitle.get(m.title) ?? 0) + m.minutes);
  const topSinks = [...byTitle]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([title, minutes]) => ({ title, hours: Math.round((minutes / 60) * 10) / 10 }));
  return { count, hours, pctOfWeek, passiveCount, topSinks };
}
