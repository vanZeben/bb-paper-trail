/** grid.ts — layout data for the contribution grid (weeks as columns, Mon-Fri rows). */
import type { AreaSnapshot, CovStatus, GridCell, GridV2, GridWeek, WorklogIndex, WorklogStatus } from "../types";
import { isoWeekOf, previousWeeks, weekDates } from "./dates";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
type IndexDay = WorklogIndex["days"][string];

const RANK = { ok: 0, partial: 1, failed: 2 } as const;
/** The stored worst status, recomputed from the per-source map when there is one so `off` sources never count. */
function worstOf(entry: IndexDay): CovStatus {
  const statuses = Object.values(entry.coverage ?? {});
  if (statuses.length === 0) return entry.worstCoverage === "off" ? "ok" : entry.worstCoverage;
  return statuses.reduce<"ok" | "partial" | "failed">((worst, s) => (s !== "off" && RANK[s] > RANK[worst] ? s : worst), "ok");
}

const emptyLens = { aiRating: null, overridden: false, areas: [] as string[], meetingPct: null, evidenceCount: 0, evidenceBySource: {} as Record<string, number>, planAdvanced: null, coverage: {} as Record<string, CovStatus> };

/**
 * `weeks` columns, oldest first, ending with the week that contains `today`. Fills the base lens fields from the index;
 * feature contributors (overrides, plan, markers) refine them afterwards.
 */
export function buildGrid(
  index: WorklogIndex,
  today: string,
  weeks: number,
  status: WorklogStatus,
  opts: { areas: AreaSnapshot[]; timeZone: string; workdayHours: number },
): GridV2 {
  const currentWeek = isoWeekOf(today);
  const columns = [...previousWeeks(currentWeek, Math.max(1, weeks) - 1), currentWeek];
  let prevMonth: number | null = null;
  const out: GridWeek[] = columns.map((week) => {
    const dates = weekDates(week);
    const month = Number(dates[0]!.slice(5, 7)) - 1;
    const monthLabel = prevMonth === null || month !== prevMonth ? MONTHS[month]! : null;
    prevMonth = month;
    const cells: GridCell[] = dates.map((date) => {
      const entry = index.days[date];
      const base = { date, rating: null, provisional: false, reason: null, meetingHours: null, worstCoverage: null, ...emptyLens };
      if (date > today) return { ...base, state: "future" };
      if (entry === undefined) return { ...base, state: "empty" };
      const lens = {
        aiRating: entry.rating,
        overridden: false,
        areas: entry.areas ?? [],
        meetingPct: opts.workdayHours > 0 ? (entry.meetingMinutes / 60 / opts.workdayHours) * 100 : null,
        evidenceCount: entry.evidenceCount,
        evidenceBySource: entry.evidenceBySource ?? {},
        planAdvanced: null,
        coverage: entry.coverage ?? {},
      };
      const common = { date, reason: entry.reason, meetingHours: Math.round((entry.meetingMinutes / 60) * 10) / 10, worstCoverage: worstOf(entry), ...lens };
      if (entry.rating === null) return { ...common, state: "unrated", rating: null, provisional: false };
      return { ...common, state: "rated", rating: entry.rating, provisional: entry.provisional };
    });
    const summary = index.weeks[week];
    return {
      week,
      from: dates[0]!,
      label: week.slice(-2),
      monthLabel,
      rating: summary?.rating ?? null,
      final: summary?.final ?? false,
      cells,
      markers: { guardrail: null, guardrailCount: 0, drift: null, shipped: 0, needClosure: 0, planHitRate: null },
    };
  });
  const anyAreas = Object.values(index.days).some((d) => (d.areas ?? []).length > 0);
  return {
    today,
    currentWeek,
    weeks: out,
    status,
    areas: opts.areas,
    lensAvailability: { rating: true, area: anyAreas, meeting: true, evidence: true, plan: false },
    timeZone: opts.timeZone,
    workdayHours: opts.workdayHours,
  };
}
