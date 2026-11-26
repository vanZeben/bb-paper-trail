/** schedule.ts — "is a cron slot due" in a time zone, for fixed minutes/hours/weekday crons ("45 17 * * 1-5"). */
import { localParts } from "./time";

const WEEKDAY_INDEX: Record<string, number> = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };

function field(raw: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const m = part.match(/^(\*|\d+)(?:-(\d+))?$/);
    if (!m) return null;
    const lo = m[1] === "*" ? min : Number(m[1]);
    const hi = m[1] === "*" ? max : Number(m[2] ?? m[1]);
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += 1) out.add(v);
  }
  return out;
}

export interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  weekdays: Set<number>;
}

/** The supported cron shape is "M H * * DOW" (lists and ranges allowed per field). Null for anything else. */
export function parseCron(cronExpr: string): ParsedCron | null {
  const f = String(cronExpr || "").trim().split(/\s+/);
  if (f.length !== 5 || f[2] !== "*" || f[3] !== "*") return null;
  const minutes = field(f[0]!, 0, 59);
  const hours = field(f[1]!, 0, 23);
  const weekdays = field(f[4]!.replace(/\b7\b/g, "0"), 0, 6);
  return minutes && hours && weekdays ? { minutes, hours, weekdays } : null;
}

export const isSupportedCron = (cronExpr: string): boolean => parseCron(cronExpr) !== null;

/**
 * Local-time "M H,H * * DOW" cron -> the latest slot ("YYYY-MM-DD HH:MM" in `timeZone`) due at `now`, or null: not a
 * scheduled weekday, before the first slot, already run (`lastSlot` >= it), or missed by more than `maxLateMs`.
 * Pure: the caller stores the returned slot after a completed run.
 */
export function dueRefreshSlot({ now, timeZone, cronExpr, lastSlot = null, maxLateMs }: { now: Date; timeZone: string; cronExpr: string; lastSlot?: string | null; maxLateMs: number }): string | null {
  const cron = parseCron(cronExpr);
  if (!cron) return null;
  const { minutes, hours, weekdays: dowRaw } = cron;
  const { date, time, weekday } = localParts(now, timeZone);
  if (!dowRaw.has(WEEKDAY_INDEX[weekday]!)) return null;
  const [h, m] = time.split(":").map(Number) as [number, number];
  const nowMin = h * 60 + m;
  const slots = [...hours].flatMap((hh) => [...minutes].map((mm) => hh * 60 + mm)).filter((t) => t <= nowMin).sort((a, b) => a - b);
  const latest = slots[slots.length - 1];
  if (latest === undefined) return null;
  if ((nowMin - latest) * 60_000 > maxLateMs) return null;
  const slot = `${date} ${String(Math.floor(latest / 60)).padStart(2, "0")}:${String(latest % 60).padStart(2, "0")}`;
  return lastSlot !== null && lastSlot >= slot ? null : slot;
}
