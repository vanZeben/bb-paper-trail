import { describe, expect, it } from "vitest";
import { isSupportedCron, parseCron } from "../lib/engine/schedule";
import { cronProblems, DEFAULT_SETTINGS } from "../lib/settings";

describe("cron validation", () => {
  it("accepts the shipped defaults and common forms", () => {
    for (const c of ["45 17 * * 1-5", "0 18 * * 5", "30 9,17 * * 1,3,5", "0 18 * * 7"]) expect(isSupportedCron(c), c).toBe(true);
    expect(cronProblems(DEFAULT_SETTINGS)).toEqual([]);
    expect(parseCron("45 17 * * 1-5")!.weekdays.size).toBe(5);
  });

  it("rejects what the parser cannot handle", () => {
    for (const c of ["", "every day", "*/15 * * * *", "0 25 * * 1", "0 18 1 * 5", "0 18 * * 9", "0 18 * *"]) expect(isSupportedCron(c), c).toBe(false);
  });

  it("explains which setting is wrong, with an example", () => {
    const problems = cronProblems({ dailyCron: "daily at five", weeklyCron: "0 18 * * 5" });
    expect(problems).toEqual(["Daily capture schedule 'daily at five' isn't understood; use e.g. 45 17 * * 1-5"]);
    expect(cronProblems({ dailyCron: "45 17 * * 1-5", weeklyCron: "friday" })[0]).toContain("Weekly judgment schedule 'friday'");
  });
});
