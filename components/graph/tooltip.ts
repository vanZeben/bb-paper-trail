// Pure content for the cell and week-header tooltips: rows of label/value text, so the popover component is only layout.
import type { GridCell, GridWeek, Severity } from "../../lib/types";
import { areaLabel, coverageGlyph, formatHours, formatPct, RATING_LABEL, weekdayLabel } from "./helpers";
import type { LensCtx } from "./lenses";

export interface TipRow {
  label: string;
  value: string;
}
export interface TipContent {
  title: string;
  rows: TipRow[];
}

export function cellTip(cell: GridCell, ctx: LensCtx): TipContent {
  if (cell.state === "future") return { title: weekdayLabel(cell.date), rows: [{ label: "Status", value: "Upcoming" }] };
  const rows: TipRow[] = [];
  if (cell.state === "rated" && cell.rating) {
    const base = RATING_LABEL[cell.rating] + (cell.provisional ? " (provisional)" : "");
    rows.push({ label: "Rating", value: cell.overridden && cell.aiRating ? `${base} · AI said ${RATING_LABEL[cell.aiRating]}` : base });
  } else {
    rows.push({ label: "Rating", value: cell.state === "unrated" ? "Captured, not rated" : "No data" });
  }
  if (cell.areas.length > 0) rows.push({ label: "Areas", value: cell.areas.map((a) => areaLabel(ctx.areas, a)).join(", ") });
  if (cell.meetingHours !== null) rows.push({ label: "Meetings", value: `${formatHours(cell.meetingHours)}${cell.meetingPct !== null ? ` · ${formatPct(cell.meetingPct)} of the day` : ""}` });
  if (cell.state !== "empty") {
    const sources = Object.entries(cell.evidenceBySource).filter(([, n]) => n > 0);
    rows.push({
      label: "Evidence",
      value: cell.evidenceCount === 0 ? "none" : `${cell.evidenceCount}${sources.length > 0 ? ` (${sources.map(([s, n]) => `${s} ${n}`).join(", ")})` : ""}`,
    });
  }
  const cov = Object.entries(cell.coverage);
  if (cov.length > 0) rows.push({ label: "Coverage", value: cov.map(([s, c]) => `${s} ${coverageGlyph(c)}`).join("  ") });
  if (cell.planAdvanced !== null) rows.push({ label: "Plan", value: `${cell.planAdvanced} item${cell.planAdvanced === 1 ? "" : "s"} advanced` });
  return { title: weekdayLabel(cell.date), rows };
}

const SEVERITY_LABEL: Record<Severity, string> = { info: "info", warning: "warning", breach: "breach" };

export function weekTip(week: GridWeek): TipContent {
  const rows: TipRow[] = [];
  rows.push({
    label: "Rating",
    value: week.rating && week.final ? RATING_LABEL[week.rating] : week.final ? "No rating" : "Not final",
  });
  const m = week.markers;
  if (m.guardrail !== null) rows.push({ label: "Guardrails", value: `${m.guardrailCount} open · worst: ${SEVERITY_LABEL[m.guardrail]}` });
  if (m.drift !== null) rows.push({ label: "Time drift", value: m.drift === "off" ? "off target" : "watch" });
  if (m.shipped > 0) rows.push({ label: "Shipped", value: String(m.shipped) });
  if (m.needClosure > 0) rows.push({ label: "Need closure", value: String(m.needClosure) });
  if (m.planHitRate !== null) rows.push({ label: "Plan hit rate", value: formatPct(m.planHitRate * 100) });
  return { title: `${week.week} · from ${week.from}`, rows };
}
