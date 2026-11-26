// Honest cost of a backfill, in background agent runs (hidden agent threads). Mirrors how the engine groups jobs:
// per week one run each for code, issues, docs and notes/memory (when connected), per workday meetings + chat + a rating,
// and one weekly judgment.
import type { ConnectorCheck } from "../../lib/types";

const WORKDAYS = 5;
const MEETING_SOURCES = ["calendar", "granola", "fellow"];
const RANGE_SOURCES = ["github", "jira", "confluence"];
const CONTEXT_SOURCES = ["vault", "memory"];

export function estimateRuns(check: ConnectorCheck | null, weeks: number): { perWeek: number; total: number } {
  const on = (id: string) => check?.sources[id]?.available !== false;
  const perDay = (MEETING_SOURCES.some(on) ? 1 : 0) + (on("slack") ? 1 : 0) + 1;
  const ranges = RANGE_SOURCES.filter(on).length + (CONTEXT_SOURCES.some(on) ? 1 : 0);
  const perWeek = WORKDAYS * perDay + ranges + 1;
  return { perWeek, total: perWeek * weeks };
}
