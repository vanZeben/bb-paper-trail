import { PLUGIN_ID } from "../../lib/meta";
// What a grid cell looks like, as one pure function of (lens, cell, context). The Grid renders whatever this returns,
// so a new lens is one new case here and nothing else. Colours are CSS variables (LENS_CSS defines them for light and
// dark); nothing is encoded by colour alone: the tooltip, the aria-label and the legend carry every value.
//
// Palettes come from the dataviz skill's validated default set and were checked with its validator:
// categorical = the 8 hue slots (adjacent-pair CVD and normal-vision gates pass in both modes); the three sequential
// ramps (blue, orange, violet) each pass the ordinal check (one hue, monotone lightness, light end >= 2:1 on the surface).
import type { AreaSnapshot, GridCell, GridV2 } from "../../lib/types";
import { cellStyle, DASHED, type CellStyle } from "./helpers";

export type Lens = "rating" | "area" | "meeting" | "evidence" | "plan";
export const DEFAULT_LENS: Lens = "rating";
export const LENS_STORAGE_KEY = `${PLUGIN_ID}.graph.lens`;

export const LENSES: ReadonlyArray<{ id: Lens; label: string; hint: string }> = [
  { id: "rating", label: "Rating", hint: "The day's rating, with your changes applied" },
  { id: "area", label: "Area", hint: "The role area the day mostly touched" },
  { id: "meeting", label: "Meetings", hint: "Share of the working day spent in meetings" },
  { id: "evidence", label: "Evidence", hint: "How many evidence items the day has" },
  { id: "plan", label: "Plan", hint: "Plan items with evidence that day" },
];

/** Grid-level facts a lens may need that are not on the cell. All of it comes from the `grid.get` payload. */
export interface LensCtx {
  areas: readonly AreaSnapshot[];
  workdayHours: number;
  today: string;
}

// ─── palettes ───────────────────────────────────────────────────────────────
/** Categorical slots 1-8 in fixed order (blue, orange, aqua, yellow, magenta, green, violet, red), then "other". */
export const AREA_COLORS = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948", "#898781"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#0ca30c", "#9085e9", "#e66767", "#898781"],
} as const;
/** Five steps, lowest to highest intensity. In dark mode the highest step is the lightest. */
export const RAMPS = {
  meeting: {
    light: ["#f0996d", "#e47a4a", "#d25f2c", "#ae4a1f", "#873a16"],
    dark: ["#873a16", "#ae4a1f", "#d25f2c", "#e47a4a", "#f0996d"],
  },
  evidence: {
    light: ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#104281"],
    dark: ["#184f95", "#256abf", "#3987e5", "#6da7ec", "#9ec5f4"],
  },
  plan: {
    light: ["#b79ee6", "#9a7ad8", "#7c58c4", "#5e3fa0", "#432d74"],
    dark: ["#5646a8", "#6b58c8", "#8472df", "#a596ee", "#c9bdf5"],
  },
} as const;

/** The stylesheet that defines the lens colour variables; render it once inside an element with class `rc-viz`. */
export const LENS_CSS = (() => {
  const vars = (mode: "light" | "dark") =>
    [
      ...AREA_COLORS[mode].map((c, i) => `--rc-area-${i}:${c}`),
      ...(["meeting", "evidence", "plan"] as const).flatMap((lens) => RAMPS[lens][mode].map((c, i) => `--rc-${lens}-${i}:${c}`)),
    ].join(";");
  return `.rc-viz{${vars("light")}}.dark .rc-viz,[data-theme="dark"] .rc-viz{${vars("dark")}}`;
})();

const v = (lens: string, i: number): string => `var(--rc-${lens}-${i})`;

// ─── bins ───────────────────────────────────────────────────────────────────
export const MEETING_BINS = ["0-20%", "20-40%", "40-60%", "60-80%", "80%+"] as const;
export const EVIDENCE_BINS = ["0", "1-3", "4-7", "8-14", "15+"] as const;
export const PLAN_BINS = ["0", "1", "2", "3", "4+"] as const;

/** 0-20 -> 0, 20-40 -> 1 ... 80+ -> 4; a boundary belongs to the higher bin. */
export const meetingBin = (pct: number): number => Math.min(4, Math.max(0, Math.floor(pct / 20)));
export const evidenceBin = (count: number): number => (count <= 0 ? 0 : count <= 3 ? 1 : count <= 7 ? 2 : count <= 14 ? 3 : 4);
export const planBin = (advanced: number): number => Math.min(4, Math.max(0, Math.floor(advanced)));

/** Index of a day's dominant area in the framework (slot 0-7), or 8 ("other") when it has none or is not listed. */
export function areaSlot(areas: readonly AreaSnapshot[], key: string): number {
  const at = areas.findIndex((a) => a.key === key);
  return at < 0 || at > 7 ? 8 : at;
}

// ─── cell look ──────────────────────────────────────────────────────────────
const FUTURE = "bg-transparent border border-dashed border-border";

function filled(cell: GridCell, color: string, glyph?: CellStyle["glyph"]): CellStyle {
  const out: CellStyle = { className: cell.state === "rated" && cell.provisional ? `opacity-50 ${DASHED}` : "", style: { backgroundColor: color } };
  if (glyph !== undefined) out.glyph = glyph;
  return out;
}

/** A cell with no value in this lens: muted, and dashed when the day was captured but has nothing to show. */
function blank(cell: GridCell): CellStyle {
  if (cell.state === "future") return { className: FUTURE, style: {} };
  return { className: cell.state === "unrated" ? `bg-muted ${DASHED}` : "bg-muted", style: {} };
}

export function cellLook(lens: Lens, cell: GridCell, ctx: LensCtx): CellStyle {
  if (cell.state === "future" || cell.state === "empty") return blank(cell);
  switch (lens) {
    case "area": {
      const first = cell.areas[0];
      if (first === undefined) return blank(cell);
      return filled(cell, v("area", areaSlot(ctx.areas, first)), cell.areas.length > 1 ? "dot" : undefined);
    }
    case "meeting":
      return cell.meetingPct === null ? blank(cell) : filled(cell, v("meeting", meetingBin(cell.meetingPct)));
    case "evidence":
      return filled(cell, v("evidence", evidenceBin(cell.evidenceCount)));
    case "plan":
      return cell.planAdvanced === null ? blank(cell) : filled(cell, v("plan", planBin(cell.planAdvanced)));
    default: {
      const base = cellStyle(cell);
      return cell.overridden ? { ...base, glyph: "corner" } : base;
    }
  }
}

// ─── availability and persistence ───────────────────────────────────────────
export type LensAvailability = GridV2["lensAvailability"];

export function lensDisabledNote(lens: Lens, availability: LensAvailability): string | null {
  if (availability[lens]) return null;
  return lens === "plan" ? "no plan yet" : "not available yet";
}

/** A stored lens name, falling back to rating when it is unknown or the lens is unavailable. */
export function parseLens(raw: string | null | undefined, availability: LensAvailability): Lens {
  const found = LENSES.find((l) => l.id === raw);
  return found !== undefined && availability[found.id] ? found.id : DEFAULT_LENS;
}

// ─── legend ─────────────────────────────────────────────────────────────────
export interface LegendItem {
  key: string;
  label: string;
  className: string;
  style: { backgroundColor?: string };
}

const ramp = (lens: "meeting" | "evidence" | "plan", labels: readonly string[]): LegendItem[] =>
  labels.map((label, i) => ({ key: `${lens}-${i}`, label, className: "", style: { backgroundColor: v(lens, i) } }));

/** The value swatches for a lens (the state swatches - provisional, future, today - are the same everywhere). */
export function legendItems(lens: Lens, areas: readonly AreaSnapshot[]): LegendItem[] {
  switch (lens) {
    case "area":
      return [
        ...areas.slice(0, 8).map((a, i) => ({ key: a.key, label: a.label, className: "", style: { backgroundColor: v("area", i) } })),
        ...(areas.length > 8 ? [{ key: "other", label: "Other areas", className: "", style: { backgroundColor: v("area", 8) } }] : []),
      ];
    case "meeting":
      return ramp("meeting", MEETING_BINS);
    case "evidence":
      return ramp("evidence", EVIDENCE_BINS);
    case "plan":
      return ramp("plan", PLAN_BINS);
    default:
      return [];
  }
}
