/** time.ts — Intl-based zone maths. The time zone is always an explicit argument; there is no default zone. */

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", weekday: "long" });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/** YYYY-MM-DD, HH:MM and weekday name of an instant in `timeZone`. */
export function localParts(date: Date, timeZone: string): { date: string; time: string; weekday: string } {
  const p: Record<string, string> = Object.fromEntries(formatter(timeZone).formatToParts(date).map((x): [string, string] => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, weekday: p.weekday! };
}

/** Offset of `timeZone` from UTC at an instant, in ms (positive east of UTC). */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
  const p: Record<string, string> = Object.fromEntries(formatter(timeZone).formatToParts(instant).map((x): [string, string] => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The first instant of calendar day `date` (YYYY-MM-DD) in `timeZone`. Handles DST changes and zones with odd offsets. */
export function zoneMidnightUtc(date: string, timeZone: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`invalid date: ${JSON.stringify(date)}`);
  const wall = Date.parse(`${date}T00:00:00Z`);
  let t = wall - zoneOffsetMs(new Date(wall), timeZone);
  t = wall - zoneOffsetMs(new Date(t), timeZone);
  // A day whose midnight falls in a gap (clocks skip forward): step to the first instant that is on `date`.
  for (let i = 0; i < 4 && localParts(new Date(t), timeZone).date < date; i += 1) t += 3_600_000;
  // A repeated midnight (clocks go back): take the earlier one.
  while (localParts(new Date(t - 60_000), timeZone).date === date) t -= 60_000;
  return new Date(t);
}
