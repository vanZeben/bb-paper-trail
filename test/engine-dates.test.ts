import { describe, expect, it } from "vitest";
import { addDays, dayBounds, isoWeekOf, isWeekday, localToday, previousWeeks, weekDates, zoneMidnightUtc } from "../lib/engine/dates";

const NY = "America/New_York";
const midnight = (d: string) => zoneMidnightUtc(d, NY);

describe("worklog dates", () => {
  it("computes ISO weeks, including year boundaries", () => {
    expect(isoWeekOf("2026-11-13")).toBe("2026-W46");
    expect(isoWeekOf("2026-01-01")).toBe("2026-W01");
    expect(isoWeekOf("2027-01-01")).toBe("2026-W53");
    expect(isoWeekOf("2024-12-30")).toBe("2025-W01");
    expect(isoWeekOf("2026-11-09")).toBe("2026-W46");
    expect(isoWeekOf("2026-11-15")).toBe("2026-W46");
  });

  it("lists Monday to Friday and rejects bad weeks", () => {
    expect(weekDates("2026-W46")).toEqual(["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"]);
    expect(weekDates("2026-W01")[0]).toBe("2025-12-29");
    expect(() => weekDates("2026-W54")).toThrow();
    expect(() => weekDates("2026-46")).toThrow();
  });

  it("does calendar math and weekday checks", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2026-11-09", -1)).toBe("2026-11-08");
    expect(isWeekday("2026-11-13")).toBe(true);
    expect(isWeekday("2026-11-14")).toBe(false);
    expect(isWeekday("2026-11-15")).toBe(false);
  });

  it("lists previous weeks oldest first across a year boundary", () => {
    expect(previousWeeks("2026-W46", 3)).toEqual(["2026-W43", "2026-W44", "2026-W45"]);
    expect(previousWeeks("2026-W02", 3)).toEqual(["2025-W51", "2025-W52", "2026-W01"]);
    expect(previousWeeks("2026-W46", 0)).toEqual([]);
  });

  it("finds New York midnight in EST and EDT and around DST changes", () => {
    expect(midnight("2026-11-13").toISOString()).toBe("2026-11-13T05:00:00.000Z");
    expect(midnight("2026-07-01").toISOString()).toBe("2026-07-01T04:00:00.000Z");
    expect(midnight("2026-03-08").toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(midnight("2026-03-09").toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(midnight("2026-11-01").toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(midnight("2026-11-02").toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });

  it("gives 23h and 25h days on DST changes", () => {
    const hours = (d: string) => (dayBounds(d, NY).end.getTime() - dayBounds(d, NY).start.getTime()) / 3_600_000;
    expect(hours("2026-03-08")).toBe(23);
    expect(hours("2026-11-01")).toBe(25);
    expect(hours("2026-11-13")).toBe(24);
  });

  it("reads today in the given zone, not UTC", () => {
    expect(localToday(new Date("2026-11-14T03:30:00Z"), NY)).toBe("2026-11-13");
  });
});

describe("non-existent weeks", () => {
  it("rejects weeks that do not round-trip (2025-W53) and accepts real ones (2026-W53)", async () => {
    const { isValidWeek, weekMonday } = await import("../lib/engine/dates");
    expect(isValidWeek("2025-W53")).toBe(false);
    expect(() => weekDates("2025-W53")).toThrow(/does not exist/);
    expect(isValidWeek("2026-W53")).toBe(true);
    expect(weekMonday("2026-W53")).toBe("2026-12-28");
    expect(isValidWeek("2026-W46")).toBe(true);
  });
});
