import { describe, expect, it } from "vitest";
import { confluenceActivityJob, createConfluenceAgentActivity, validateConfluenceActivity } from "../lib/capture/confluence";
import type { Runner } from "../lib/engine/runner";

const range = { from: "2026-08-17", to: "2026-08-18" };

describe("validateConfluenceActivity", () => {
  it("maps entries and rejects bad kinds or dates", () => {
    const out = validateConfluenceActivity({ available: true, note: null, entries: [{ date: "2026-08-17", kind: "doc_edited", title: "ADR", url: "https://x.atlassian.net/wiki/1", detail: "3 edits" }] }, range);
    expect(out["2026-08-17"]!.entries[0]).toMatchObject({ source: "confluence", what: 'Edited "ADR" (3 edits)', link: "https://x.atlassian.net/wiki/1" });
    expect(out["2026-08-18"]!.entries).toEqual([]);
    expect(() => validateConfluenceActivity({ available: true, entries: [{ date: "2026-08-17", kind: "liked", title: "x" }] }, range)).toThrow(/kind/);
    expect(() => validateConfluenceActivity({ available: true, entries: [{ date: "2026-09-01", kind: "doc_edited", title: "x" }] }, range)).toThrow(/outside/);
    expect(() => validateConfluenceActivity({ available: true, entries: [{ date: "2026-08-17", kind: "doc_edited" }] }, range)).toThrow(/title/);
  });
  it("words each kind and drops non-https links", () => {
    const rows = [
      { date: "2026-08-17", kind: "doc_created", title: "RFC", url: "http://insecure/x" },
      { date: "2026-08-17", kind: "doc_commented", title: "RFC", detail: "2 comments" },
    ];
    const e = validateConfluenceActivity({ available: true, entries: rows }, range)["2026-08-17"]!.entries;
    expect(e.map((x) => x.what)).toEqual(['Wrote "RFC"', 'Commented on "RFC" (2 comments)']);
    expect(e[0]!.link).toBeNull();
  });
  it("passes unavailability through as failed on every date", () => {
    const out = validateConfluenceActivity({ available: false, note: "no wiki tools" }, range);
    expect(Object.keys(out)).toEqual(["2026-08-17", "2026-08-18"]);
    expect(out["2026-08-18"]!.coverage).toEqual({ status: "failed", note: "no wiki tools" });
  });
});

describe("confluenceActivityJob", () => {
  it("is a read-only prompt with the range, the zone and the version-history rule", () => {
    const job = confluenceActivityJob(range, { timeZone: "America/New_York" });
    expect(job.prompt).toContain("2026-08-17 to 2026-08-18");
    expect(job.prompt).toContain("America/New_York dates");
    expect(job.prompt).toContain('lastmodified >= "2026-08-16"');
    expect(job.prompt).toMatch(/Never create, edit or comment/);
    expect(job.prompt).toMatch(/version history/);
  });
});

describe("createConfluenceAgentActivity", () => {
  it("returns an agent source", async () => {
    const calls: string[] = [];
    const runner = { runJob: async (job: { kind: string }) => (calls.push(job.kind), {}), status: () => ({}) } as unknown as Runner;
    const src = createConfluenceAgentActivity(runner, () => undefined, { timeZone: "America/New_York" });
    expect(src.kind).toBe("agent");
    await src.fetch(range);
    expect(calls).toEqual(["worklog-confluence"]);
  });
});

describe("confluence identity", () => {
  const identity = { name: "Alex Doe", email: "alex@example.com", handles: { slack: "U0ALEX", github: "alexdoe" } };
  it("adds the identity line", () => {
    expect(confluenceActivityJob(range, { timeZone: "America/New_York", identity }).prompt).toContain("The user is Alex Doe (alex@example.com; Slack U0ALEX; GitHub @alexdoe). In meeting transcripts and notes, their lines are attributed to this name or email.");
    expect(confluenceActivityJob(range, { timeZone: "America/New_York" }).prompt).not.toContain("The user is");
  });
});
