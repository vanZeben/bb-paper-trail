// The Graph tab's status line: when the newest captured day was, in words. The grid carries dates, not timestamps, so
// this is day-accurate. There is no next-run time on the grid payload, so none is shown.
import type { GridWeek } from "../../lib/types";

/** Newest date (YYYY-MM-DD) with anything captured, or null. */
export function lastCapturedDate(weeks: readonly Pick<GridWeek, "cells">[]): string | null {
  let latest: string | null = null;
  for (const week of weeks) {
    for (const cell of week.cells) {
      if (cell.state === "future" || cell.state === "empty") continue;
      if (latest === null || cell.date > latest) latest = cell.date;
    }
  }
  return latest;
}

const dayNumber = (date: string): number => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 86_400_000;

/** "today", "yesterday", "3 days ago", "2 weeks ago". */
export function daysAgoLabel(date: string, today: string): string {
  const days = Math.round(dayNumber(today) - dayNumber(date));
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  return `${Math.round(days / 7)} weeks ago`;
}

export function captureStatusLine(weeks: readonly Pick<GridWeek, "cells">[], today: string): string {
  const last = lastCapturedDate(weeks);
  return last === null ? "Nothing captured yet" : `Last captured ${daysAgoLabel(last, today)}`;
}
