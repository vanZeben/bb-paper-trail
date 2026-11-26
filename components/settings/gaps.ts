// Pure helper for "Fill gaps": days recorded with an `off` or never-captured source that the latest connector check now
// finds available. A source that was never attempted is stored as {status:"failed", note:"not captured"}; the grid index
// only keeps the status, so a `failed` day for an available source is fillable too (a retry is what Fill gaps does).
// Structural types only, so this file pulls nothing from the server into the bundle.
interface GapCell {
  date: string;
  state: string;
  coverage: Record<string, string>;
}
interface GapGrid {
  weeks: ReadonlyArray<{ cells: ReadonlyArray<GapCell> }>;
}
interface GapCheck {
  sources: Record<string, { available: boolean | null }>;
}

/** Coverage values that Fill gaps can retry: skipped (`off`), never captured, or failed. */
const FILLABLE: ReadonlySet<string> = new Set(["off", "not_captured", "failed"]);

/** The server's cap on a fill-gaps run (MAX_BACKFILL_WEEKS in lib/types.ts). */
export const MAX_FILL_WEEKS = 40;

/** `days`: past days with a gap; `weeks`: weeks from the oldest gap to the newest week, capped at MAX_FILL_WEEKS. */
export function gapSummary(grid: GapGrid | null, check: GapCheck | null): { days: number; weeks: number } {
  if (grid === null || check === null) return { days: 0, weeks: 0 };
  const available = Object.entries(check.sources).filter(([, s]) => s.available === true).map(([id]) => id);
  let days = 0;
  let oldest = -1;
  grid.weeks.forEach((week, index) => {
    for (const cell of week.cells) {
      if (cell.state === "future" || cell.state === "empty") continue;
      if (available.some((id) => FILLABLE.has(cell.coverage[id] ?? ""))) {
        days += 1;
        if (oldest === -1) oldest = index;
      }
    }
  });
  return days === 0 ? { days: 0, weeks: 0 } : { days, weeks: Math.min(MAX_FILL_WEEKS, grid.weeks.length - oldest) };
}
