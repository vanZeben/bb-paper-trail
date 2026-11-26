import { describe, expect, it } from "vitest";
import { captureStatusLine, daysAgoLabel, lastCapturedDate } from "../components/graph/captureStatus";
import { prefillIdentity, roleCardProblem } from "../components/onboarding/prefill";

const cell = (date: string, state: string) => ({ date, state }) as never;

describe("graph status line", () => {
  it("finds the newest captured day, ignoring future and empty cells", () => {
    const weeks = [{ cells: [cell("2026-11-16", "rated"), cell("2026-11-17", "unrated")] }, { cells: [cell("2026-11-18", "empty"), cell("2026-11-19", "future")] }];
    expect(lastCapturedDate(weeks)).toBe("2026-11-17");
    expect(captureStatusLine(weeks, "2026-11-20")).toBe("Last captured 3 days ago");
    expect(captureStatusLine([{ cells: [cell("2026-11-19", "future")] }], "2026-11-20")).toBe("Nothing captured yet");
  });
  it("words the distance", () => {
    expect(daysAgoLabel("2026-11-20", "2026-11-20")).toBe("today");
    expect(daysAgoLabel("2026-11-19", "2026-11-20")).toBe("yesterday");
    expect(daysAgoLabel("2026-11-01", "2026-11-20")).toBe("3 weeks ago");
  });
});

describe("setup form helpers", () => {
  const check = (sources: Record<string, string | null>) => ({
    checkedAt: "t", hostId: "h", hostName: "H", model: null,
    sources: Object.fromEntries(Object.entries(sources).map(([k, account]) => [k, { available: true, via: null, account, note: null, mode: null }])),
  });
  it("prefills a name and email only when the accounts agree, and collects @handles", () => {
    const ok = prefillIdentity(check({ calendar: "alex@example.com", github: "@alexd", slack: "Alex Doe", jira: "Alex Doe" }));
    expect(ok).toEqual({ name: "Alex Doe", email: "alex@example.com", handles: { github: "alexd" } });
    const split = prefillIdentity(check({ slack: "Alex Doe", jira: "Sam Lee", calendar: "a@example.com", granola: "b@example.com" }));
    expect(split.name).toBe("");
    expect(split.email).toBe("");
    expect(prefillIdentity(null)).toEqual({ name: "", email: "", handles: {} });
  });
  it("validates the role card by kind", () => {
    expect(roleCardProblem("text", "  ")).toMatch(/Add your role card/);
    expect(roleCardProblem("text", "x".repeat(20001))).toMatch(/limit/);
    expect(roleCardProblem("url", "ftp://x")).toMatch(/http/);
    expect(roleCardProblem("url", "https://example.com/card")).toBeNull();
    expect(roleCardProblem("note", "Notes/Role.md")).toBeNull();
  });
});
