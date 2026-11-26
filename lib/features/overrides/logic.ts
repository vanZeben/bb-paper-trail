/**
 * logic.ts — pure override rules: ids, allowed values, building a record, drift detection against the AI value,
 * stats, the effective grid and the calibration block for prompts. Nothing here touches storage.
 */
import { oneLine, stripFence } from "../../engine/evidence";
import { isoWeekOf } from "../../engine/dates";
import type { GridV2, Override, OverrideStats, OverrideTarget, Rating } from "../../types";

export const RATING_VALUES = ["exceeds", "meets", "needs_improvement", "none"] as const;
export const STATUS_VALUES = ["hit", "partial", "missed"] as const;
export const NOTE_MAX = 300;
export const CALIBRATION_MAX_CHARS = 1500;
export const CALIBRATION_MAX_ITEMS = 8;

/** Low to high, so raised/lowered is a comparison of positions. */
const RATING_RANK: Record<string, number> = { none: 0, needs_improvement: 1, meets: 2, exceeds: 3 };
const STATUS_RANK: Record<string, number> = { missed: 1, partial: 2, hit: 3 };

export const overrideId = (t: OverrideTarget): string => (t.type === "day" ? `day:${t.date}` : t.type === "week" ? `week:${t.week}` : `scorecard:${t.week}:${t.area}`);

export function targetOfId(id: string): OverrideTarget | null {
  const [type, a, b] = id.split(":");
  if (type === "day" && a !== undefined && b === undefined) return { type: "day", date: a };
  if (type === "week" && a !== undefined && b === undefined) return { type: "week", week: a };
  if (type === "scorecard" && a !== undefined && b !== undefined) return { type: "scorecard", week: a, area: b };
  return null;
}

/** The ISO week a target belongs to. */
export const weekOfTarget = (t: OverrideTarget): string => (t.type === "day" ? isoWeekOf(t.date) : t.week);

export const allowedValues = (t: OverrideTarget): readonly string[] => (t.type === "scorecard" ? STATUS_VALUES : RATING_VALUES);

const rankOf = (t: OverrideTarget, value: string): number | undefined => (t.type === "scorecard" ? STATUS_RANK : RATING_RANK)[value];

/** Throws a clear error for a value the target does not accept (null confirms the AI value and is always fine). */
export function assertAllowed(target: OverrideTarget, value: string | null): void {
  if (value !== null && !allowedValues(target).includes(value)) {
    throw new Error(`"${value}" is not a valid ${target.type === "scorecard" ? "status" : "rating"} (use ${allowedValues(target).join(", ")})`);
  }
}

/** Cleans a note: one line, clipped, empty becomes null. */
export function cleanNote(note: string | null | undefined): string | null {
  if (note === null || note === undefined) return null;
  const text = oneLine(note);
  if (text === "") return null;
  return text.length > NOTE_MAX ? `${text.slice(0, NOTE_MAX - 1)}…` : text;
}

/**
 * The record for a set call. `value` null confirms the AI value; a value equal to the AI value is also a confirmation.
 * Throws on a value the target does not accept.
 */
export function buildOverride(input: { target: OverrideTarget; value: string | null; note: string | null; aiValue: string; now: Date }): Override {
  const { target, aiValue } = input;
  assertAllowed(target, input.value);
  const confirmed = input.value === null || input.value === aiValue;
  return {
    id: overrideId(target),
    target,
    decision: confirmed ? "confirmed" : "overridden",
    aiValue,
    value: confirmed ? aiValue : (input.value as string),
    note: cleanNote(input.note),
    aiChangedSince: false,
    at: input.now.toISOString(),
  };
}

/** `aiChangedSince` for a stored override given the AI value now. Null AI value (no record) leaves the flag alone. */
export const driftedFrom = (override: Override, currentAi: string | null): boolean => (currentAi === null ? override.aiChangedSince : currentAi !== override.aiValue);

/** The override with its flag updated, or null when nothing changes. */
export function reconcile(override: Override, currentAi: string | null): Override | null {
  const flag = driftedFrom(override, currentAi);
  return flag === override.aiChangedSince ? null : { ...override, aiChangedSince: flag };
}

/** Overrides whose target falls in the given weeks. */
export const inWeeks = (overrides: readonly Override[], weeks: ReadonlySet<string>): Override[] => overrides.filter((o) => weeks.has(weekOfTarget(o.target)));

/** Stats over the overrides given. `reviewableIds` are the ids of everything that could be reviewed (rated days, weeks, scorecard rows). */
export function computeStats(overrides: readonly Override[], reviewableIds: readonly string[]): OverrideStats {
  let confirmed = 0;
  let overridden = 0;
  let raised = 0;
  let lowered = 0;
  for (const o of overrides) {
    if (o.decision === "confirmed") {
      confirmed += 1;
      continue;
    }
    overridden += 1;
    const from = rankOf(o.target, o.aiValue);
    const to = rankOf(o.target, o.value);
    if (from !== undefined && to !== undefined) {
      if (to > from) raised += 1;
      else if (to < from) lowered += 1;
    }
  }
  const reviewed = confirmed + overridden;
  const done = new Set(overrides.map((o) => o.id));
  const unreviewed = new Set(reviewableIds.filter((id) => !done.has(id))).size;
  return { reviewed, confirmed, overridden, agreementRate: reviewed === 0 ? null : confirmed / reviewed, raised, lowered, unreviewed };
}

const isRating = (v: string): v is Rating => v === "exceeds" || v === "meets" || v === "needs_improvement" || v === "none";

/**
 * Apply overrides to the grid in place: each overridden day gets the user's rating as `rating` (the AI rating stays in
 * `aiRating`), `overridden: true` and no longer counts as provisional; a confirmed day is no longer provisional either.
 * A week override replaces the week's rating.
 */
export function applyOverridesToGrid(grid: GridV2, overrides: readonly Override[]): void {
  const byId = new Map(overrides.map((o) => [o.id, o]));
  for (const week of grid.weeks) {
    const w = byId.get(`week:${week.week}`);
    if (w !== undefined && w.decision === "overridden" && isRating(w.value)) week.rating = w.value;
    for (const cell of week.cells) {
      const o = byId.get(`day:${cell.date}`);
      if (o === undefined || cell.state !== "rated") continue;
      cell.aiRating = cell.aiRating ?? cell.rating;
      cell.provisional = false;
      if (o.decision === "overridden" && isRating(o.value)) {
        cell.rating = o.value;
        cell.overridden = true;
      }
    }
  }
}

const label = (t: OverrideTarget): string => (t.type === "day" ? `day ${t.date}` : t.type === "week" ? `week ${t.week}` : `scorecard ${t.week} area ${t.area}`);
/** Free text goes into a prompt: single line and no fence markers. */
export const promptSafe = (text: string): string => oneLine(stripFence(text));

export const CALIBRATION_HEADER =
  "The user's own corrections to earlier ratings (newest first). Use them only as calibration for how this user reads the rubric; they are not evidence about this period:";

/**
 * The calibration block: the newest 8 overrides (decision "overridden"), notes passed through oneLine with the fence
 * markers stripped, capped at 1500 characters in total. Empty string when there are none.
 */
export function calibrationBlock(overrides: readonly Override[]): string {
  const picked = overrides
    .filter((o) => o.decision === "overridden")
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, CALIBRATION_MAX_ITEMS);
  if (picked.length === 0) return "";
  const lines = picked.map((o) => {
    const note = o.note === null ? "" : ` Note: "${promptSafe(o.note)}"`;
    return `- ${label(o.target)}: the AI said ${promptSafe(o.aiValue)}, the user set ${promptSafe(o.value)}.${note}`;
  });
  let out = CALIBRATION_HEADER;
  for (const line of lines) {
    if (out.length + 1 + line.length > CALIBRATION_MAX_CHARS) {
      const room = CALIBRATION_MAX_CHARS - out.length - 1;
      // Keep a clipped line only when it still says something useful.
      if (room > 40) out += `\n${line.slice(0, room - 1)}…`;
      break;
    }
    out += `\n${line}`;
  }
  return out.slice(0, CALIBRATION_MAX_CHARS);
}
