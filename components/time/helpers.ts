// UI-side helpers for the Time tab. Type-only imports from lib (no zod / SDK in the app bundle).
import type { DriftSnapshot, WeekMix } from "../../lib/types";
import { AREA_COLORS } from "../graph/lenses";

/** Categorical slots 1-8 are the graph's palette (one source, so an area keeps its colour across tabs); areas past 8 fold into "Other". */
export const AREA_PALETTE = AREA_COLORS;
export const MAX_SLOTS = 8;
export const OTHER_COLOR = "var(--rc-time-other)";
export const TIME_CSS = (() => {
  const vars = (m: "light" | "dark") => AREA_PALETTE[m].map((c, i) => (i < MAX_SLOTS ? `--rc-time-${i}:${c}` : `--rc-time-other:${c}`)).join(";");
  return `.rc-time{${vars("light")}}.dark .rc-time,[data-theme="dark"] .rc-time{${vars("dark")}}`;
})();
export const slotColor = (i: number): string => (i < MAX_SLOTS ? `var(--rc-time-${i})` : OTHER_COLOR);

export interface AreaInfo {
  key: string;
  label: string;
}

/** "Mentorship 18 points under target". */
export function driftSentence(label: string, pp: number): string {
  const n = Math.abs(Math.round(pp * 10) / 10);
  return n === 0 ? `${label} is on target` : `${label} ${n} point${n === 1 ? "" : "s"} ${pp > 0 ? "over" : "under"} target`;
}

export const STATUS_LABEL = { aligned: "Aligned", watch: "Watch", off: "Off target" } as const;
export const STATUS_TONE = {
  aligned: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  watch: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  off: "bg-red-500/15 text-red-700 dark:text-red-300",
} as const;

export const METHOD_NOTE = "Estimated from the areas each rated day touched, not hours. Each rated day counts as one unit, split equally across the areas it touched.";

export const shortWeek = (week: string): string => week.replace(/^\d{4}-/, "");

/** Even whole-number split of 100 over `keys` (the first ones take the remainder). */
export function evenTargets(keys: readonly string[]): Record<string, number> {
  const base = Math.floor(100 / keys.length);
  const extra = 100 - base * keys.length;
  return Object.fromEntries(keys.map((k, i) => [k, base + (i < extra ? 1 : 0)]));
}

export const totalOf = (t: Record<string, number>): number => Math.round(Object.values(t).reduce((s, v) => s + v, 0) * 10) / 10;
/** Targets are valid when they total 100 give or take 1. */
export const targetsValid = (t: Record<string, number>): boolean => Math.abs(totalOf(t) - 100) <= 1;

export type MixRow = Pick<WeekMix, "week" | "actual" | "daysCounted">;
export type SnapshotLike = Pick<DriftSnapshot, "score" | "status" | "perArea" | "biggestOver" | "biggestUnder">;
