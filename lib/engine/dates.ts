/** dates.ts — pure date and ISO week helpers (YYYY-MM-DD strings, YYYY-Www weeks). Zone-aware parts take a time zone. */
import { localParts, zoneMidnightUtc } from "./time";

const DAY = 86_400_000;
const WEEK_RE = /^(\d{4})-W(0[1-9]|[1-4]\d|5[0-3])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const toUtc = (date: string): Date => {
  if (!DATE_RE.test(date)) throw new Error(`invalid date: ${JSON.stringify(date)}`);
  return new Date(`${date}T00:00:00Z`);
};
const fmt = (d: Date): string => d.toISOString().slice(0, 10);

/** Today's date in `timeZone`. */
export const localToday = (now: Date, timeZone: string): string => localParts(now, timeZone).date;

/** Pure UTC calendar math on YYYY-MM-DD. */
export const addDays = (date: string, n: number): string => fmt(new Date(toUtc(date).getTime() + n * DAY));

/** ISO week of a date: the week that contains its Thursday. "2026-11-13" -> "2026-W46". */
export function isoWeekOf(date: string): string {
  const d = toUtc(date);
  const dow = (d.getUTCDay() + 6) % 7; // Mon = 0
  const thursday = new Date(d.getTime() + (3 - dow) * DAY);
  const year = thursday.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.floor((thursday.getTime() - jan1) / DAY / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Monday of an ISO week. */
export function weekMonday(week: string): string {
  const m = WEEK_RE.exec(week);
  if (!m) throw new Error(`invalid week: ${JSON.stringify(week)}`);
  const year = Number(m[1]);
  const w = Number(m[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const mondayOfW1 = jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * DAY;
  const monday = fmt(new Date(mondayOfW1 + (w - 1) * 7 * DAY));
  // W53 only exists in some years: a week that does not round-trip is not a real week.
  if (isoWeekOf(monday) !== week) throw new Error(`invalid week: ${JSON.stringify(week)} does not exist`);
  return monday;
}

export function isValidWeek(week: string): boolean {
  try {
    weekMonday(week);
    return true;
  } catch {
    return false;
  }
}

/** Mon..Fri of an ISO week; throws on a bad format. */
export function weekDates(week: string): string[] {
  const monday = weekMonday(week);
  return [0, 1, 2, 3, 4].map((i) => addDays(monday, i));
}

export function isWeekday(date: string): boolean {
  const dow = toUtc(date).getUTCDay();
  return dow >= 1 && dow <= 5;
}

/** The `n` weeks before `week`, oldest first, excluding `week` itself. */
export function previousWeeks(week: string, n: number): string[] {
  const monday = weekMonday(week);
  return Array.from({ length: n }, (_, i) => isoWeekOf(addDays(monday, -7 * (n - i))));
}

export { zoneMidnightUtc };

/** [midnight, next midnight) in `timeZone`. */
export function dayBounds(date: string, timeZone: string): { start: Date; end: Date } {
  return { start: zoneMidnightUtc(date, timeZone), end: zoneMidnightUtc(addDays(date, 1), timeZone) };
}

/** UTC instant as YYYY-MM-DDTHH:MM:SSZ (what GitHub search wants). */
export const gitHubInstant = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, "Z");
