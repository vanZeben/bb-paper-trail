import { describe, expect, it } from "vitest";
import { isValidTimeZone, localParts, zoneMidnightUtc, zoneOffsetMs } from "../lib/engine/time";

const NY = "America/New_York";
const iso = (d: string, tz: string) => zoneMidnightUtc(d, tz).toISOString();

describe("localParts", () => {
  const instant = new Date("2026-11-14T03:30:00Z");
  it("reads the wall clock in each zone", () => {
    expect(localParts(instant, NY)).toEqual({ date: "2026-11-13", time: "22:30", weekday: "Friday" });
    expect(localParts(instant, "UTC")).toEqual({ date: "2026-11-14", time: "03:30", weekday: "Saturday" });
    expect(localParts(instant, "Asia/Kolkata")).toEqual({ date: "2026-11-14", time: "09:00", weekday: "Saturday" });
  });
  it("uses a 00:xx hour, never 24:xx", () => {
    expect(localParts(new Date("2026-11-13T05:05:00Z"), NY).time).toBe("00:05");
  });
});

describe("zoneMidnightUtc", () => {
  it("finds midnight in New York (EST and EDT)", () => {
    expect(iso("2026-11-13", NY)).toBe("2026-11-13T05:00:00.000Z");
    expect(iso("2026-07-01", NY)).toBe("2026-07-01T04:00:00.000Z");
  });
  it("is the identity in UTC", () => {
    expect(iso("2026-11-13", "UTC")).toBe("2026-11-13T00:00:00.000Z");
  });
  it("handles a half-hour zone (Asia/Kolkata, UTC+5:30)", () => {
    expect(iso("2026-11-13", "Asia/Kolkata")).toBe("2026-11-12T18:30:00.000Z");
    expect(zoneOffsetMs(new Date("2026-11-13T00:00:00Z"), "Asia/Kolkata")).toBe(5.5 * 3_600_000);
  });
  it("is correct on the New York DST days", () => {
    // Spring forward 2026-03-08 02:00 -> 03:00: midnight is still EST, the next one is EDT (a 23 h day).
    expect(iso("2026-03-08", NY)).toBe("2026-03-08T05:00:00.000Z");
    expect(iso("2026-03-09", NY)).toBe("2026-03-09T04:00:00.000Z");
    // Fall back 2026-11-01 02:00 -> 01:00: midnight is EDT, the next one is EST (a 25 h day).
    expect(iso("2026-11-01", NY)).toBe("2026-11-01T04:00:00.000Z");
    expect(iso("2026-11-02", NY)).toBe("2026-11-02T05:00:00.000Z");
    const hours = (d: string, next: string) => (zoneMidnightUtc(next, NY).getTime() - zoneMidnightUtc(d, NY).getTime()) / 3_600_000;
    expect(hours("2026-03-08", "2026-03-09")).toBe(23);
    expect(hours("2026-11-01", "2026-11-02")).toBe(25);
  });
  it("round-trips: local date of the midnight instant is the date, one minute earlier is the day before", () => {
    for (const tz of [NY, "UTC", "Asia/Kolkata"]) {
      for (const d of ["2026-03-08", "2026-11-01", "2026-11-13"]) {
        const t = zoneMidnightUtc(d, tz);
        expect(localParts(t, tz)).toMatchObject({ date: d, time: "00:00" });
        expect(localParts(new Date(t.getTime() - 60_000), tz).date < d).toBe(true);
      }
    }
  });
  it("rejects a malformed date and validates zones", () => {
    expect(() => zoneMidnightUtc("11/13/2026", NY)).toThrow(/invalid date/);
    expect(isValidTimeZone(NY)).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
  });
});
