// Pure helpers for the Graph tab: colour mapping and label formatting. Type-only imports from lib/types keep zod out of
// the frontend bundle.
import type { AreaSnapshot, CovStatus, EvidenceEntry, GridCell, Rating, WorkDay, WorklogStatus } from "../../lib/types";

/** lime-400, green-700, orange-500; "none" uses the muted class instead of a colour. */
export const RATING_COLOR: Record<Rating, string> = { exceeds: "#a3e635", meets: "#15803d", needs_improvement: "#f97316", none: "" };
export const RATING_LABEL: Record<Rating, string> = { exceeds: "Exceeds", meets: "Meets", needs_improvement: "Needs improvement", none: "No data" };
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"] as const;
export const DASHED = "outline-dashed outline-1 outline-offset-[-1px] outline-foreground/50";

/** A small mark drawn on a cell: `corner` = the user changed the AI's rating; `dot` = the day touched more than one area. */
export type CellGlyph = "corner" | "dot";

export interface CellStyle {
  className: string;
  style: { backgroundColor?: string };
  glyph?: CellGlyph;
}

/** The rating lens: colour by effective rating; provisional days fade, unrated days get a dashed outline. */
export function cellStyle(cell: GridCell): CellStyle {
  if (cell.state === "future") return { className: "bg-transparent border border-dashed border-border", style: {} };
  if (cell.state === "rated" && cell.rating !== null && cell.rating !== "none") {
    return { className: cell.provisional ? `opacity-50 ${DASHED}` : "", style: { backgroundColor: RATING_COLOR[cell.rating] } };
  }
  return { className: cell.state === "unrated" ? `bg-muted ${DASHED}` : "bg-muted", style: {} };
}

export const formatHours = (hours: number): string => `${Math.round(hours * 10) / 10}h`;
/** Takes a whole-number percentage. */
export const formatPct = (pct: number): string => `${Math.round(pct)}%`;

/** Share of a working day spent in meetings, as a whole-number percentage. `workdayHours` comes from the grid payload. */
export function meetingPctOfDay(minutes: number, workdayHours: number): number {
  return workdayHours > 0 ? (minutes / 60 / workdayHours) * 100 : 0;
}

export function cellTitle(cell: GridCell): string {
  if (cell.state === "future") return `${cell.date} · upcoming`;
  const rating =
    cell.state === "rated" && cell.rating ? RATING_LABEL[cell.rating] + (cell.provisional ? " (provisional)" : "") : cell.state === "unrated" ? "captured, not rated" : "no data";
  const parts = [cell.date, rating];
  if (cell.overridden && cell.aiRating) parts.push(`AI said ${RATING_LABEL[cell.aiRating]}`);
  if (cell.meetingHours !== null) parts.push(`${formatHours(cell.meetingHours)} meetings`);
  return parts.join(" · ");
}

export function weekdayLabel(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
}

/** "11:00 AM" for an ISO instant, shown in the given IANA zone (the grid's `timeZone`). Empty string when unparseable. */
export function formatTime(iso: string | null | undefined, timeZone: string): string {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(at)) return "";
  const options: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit", hour12: true };
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone }).format(new Date(at));
  } catch {
    // An unknown zone name: show UTC and say so, rather than silently picking another zone.
    return `${new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(new Date(at))} UTC`;
  }
}

/** The label for an area key: from the payload's areas, else the key itself (an area removed from the framework). */
export function areaLabel(areas: readonly AreaSnapshot[], key: string): string {
  return areas.find((a) => a.key === key)?.label ?? key;
}

export const isWeekKey = (value: string): boolean => /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/.test(value.trim());

/** "week:2026-W46 · judging" */
export function runningLine(status: WorklogStatus): string | null {
  if (status.running === null) return null;
  return `${status.running.key}${status.running.step ? ` · ${status.running.step}` : ""}`;
}
export const isBusyKey = (status: WorklogStatus, key: string): boolean => status.running?.key === key || status.queued.includes(key);

export function coverageGlyph(status: CovStatus): string {
  return status === "ok" ? "✓" : status === "partial" ? "⚠" : status === "off" ? "–" : "✗";
}

/** Evidence kinds that rarely carry a day's story; shown after the cited and notable entries. */
const LOW_SIGNAL = ["passive", "review_light", "meeting"];
/** Up to 12 entries: those the rating cites first, then the rest minus low-signal kinds. */
export function highlights(day: WorkDay): EvidenceEntry[] {
  const cited = new Set(day.rating?.evidenceIds ?? []);
  const first = day.evidence.filter((e) => cited.has(e.id));
  const rest = day.evidence.filter((e) => !cited.has(e.id) && !LOW_SIGNAL.includes(e.kind));
  return [...first, ...rest].slice(0, 12);
}

/** Save text as a file through a temporary object URL. */
export function downloadText(filename: string, text: string, mime = "text/markdown"): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
