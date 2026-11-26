// The summary strip over the visible grid range. Pure: takes the grid weeks and the override stats.
import type { GridWeek, OverrideStats } from "../../lib/types";

export interface RangeSummary {
  daysCaptured: number;
  ratedDays: number;
  /** Share of rated days (exceeds + meets + needs improvement) that are exceeds or meets; null without rated days. */
  exceedsMeetsShare: number | null;
  /** Mean meeting share of the day over captured days with a value; null without any. */
  avgMeetingPct: number | null;
  evidenceItems: number;
  agreementRate: number | null;
  reviewed: number;
}

export function summarise(weeks: readonly GridWeek[], stats: OverrideStats | null): RangeSummary {
  let captured = 0;
  let rated = 0;
  let good = 0;
  let meetingSum = 0;
  let meetingN = 0;
  let evidence = 0;
  for (const week of weeks) {
    for (const cell of week.cells) {
      if (cell.state !== "rated" && cell.state !== "unrated") continue;
      captured += 1;
      evidence += cell.evidenceCount;
      if (cell.meetingPct !== null) {
        meetingSum += cell.meetingPct;
        meetingN += 1;
      }
      if (cell.state === "rated" && cell.rating !== null && cell.rating !== "none") {
        rated += 1;
        if (cell.rating === "exceeds" || cell.rating === "meets") good += 1;
      }
    }
  }
  return {
    daysCaptured: captured,
    ratedDays: rated,
    exceedsMeetsShare: rated === 0 ? null : good / rated,
    avgMeetingPct: meetingN === 0 ? null : meetingSum / meetingN,
    evidenceItems: evidence,
    agreementRate: stats?.agreementRate ?? null,
    reviewed: stats?.reviewed ?? 0,
  };
}
