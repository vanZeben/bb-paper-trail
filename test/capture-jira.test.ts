import { describe, expect, it } from "vitest";
import { createJiraAgentActivity, jiraActivityJob, validateJiraActivity, type JiraRange } from "../lib/capture/jira";
import type { Runner } from "../lib/engine/runner";

const SITE = "https://example.atlassian.net";
const range = { from: "2026-11-09", to: "2026-11-10" };
const TZ = "America/New_York";

describe("validateJiraActivity", () => {
  const entry = (over: Record<string, unknown> = {}) => ({ date: "2026-11-09", kind: "resolved", key: "ACME-12", summary: "Gateway", detail: "In Review -> Done", ...over });

  it("maps entries per date and builds a link from siteUrl when the entry has no url", () => {
    const out = validateJiraActivity({ available: true, note: null, entries: [entry()] }, range, `${SITE}/`);
    expect(out["2026-11-09"]!.entries[0]).toMatchObject({ source: "jira", kind: "resolved", what: "ACME-12 Gateway: In Review -> Done", link: `${SITE}/browse/ACME-12` });
    expect(out["2026-11-10"]!.entries).toEqual([]);
    expect(out["2026-11-09"]!.coverage.status).toBe("ok");
  });

  it("prefers the entry's own https url over siteUrl", () => {
    const out = validateJiraActivity({ available: true, entries: [entry({ url: "https://other.atlassian.net/browse/ACME-12" })] }, range, SITE);
    expect(out["2026-11-09"]!.entries[0]!.link).toBe("https://other.atlassian.net/browse/ACME-12");
  });

  it("gives link null with no url and no siteUrl, and ignores a non-https url", () => {
    const a = validateJiraActivity({ available: true, entries: [entry()] }, range);
    expect(a["2026-11-09"]!.entries[0]!.link).toBeNull();
    const b = validateJiraActivity({ available: true, entries: [entry({ url: "javascript:alert(1)" })] }, range, "");
    expect(b["2026-11-09"]!.entries[0]!.link).toBeNull();
  });

  it("rejects bad key, kind or date and reports unavailable", () => {
    expect(() => validateJiraActivity({ available: true, entries: [entry({ key: "nope" })] }, range, SITE)).toThrow(/key/);
    expect(() => validateJiraActivity({ available: true, entries: [entry({ kind: "liked" })] }, range, SITE)).toThrow(/kind/);
    expect(() => validateJiraActivity({ available: true, entries: [entry({ date: "2026-11-20" })] }, range, SITE)).toThrow(/range/);
    expect(validateJiraActivity({ available: false, note: "no tracker tools" }, range, SITE)["2026-11-09"]!.coverage).toEqual({ status: "failed", note: "no tracker tools" });
  });

  it("is partial when the agent reports a note", () => {
    const out = validateJiraActivity({ available: true, note: "comments unreadable", entries: [] }, range, SITE);
    expect(out["2026-11-10"]!.coverage).toEqual({ status: "partial", note: "comments unreadable" });
  });
});

describe("jiraActivityJob", () => {
  it("is a read-only, own-actions-only prompt naming the range and the zone", () => {
    const job = jiraActivityJob(range, { timeZone: TZ });
    expect(job.prompt).toContain("2026-11-09 to 2026-11-10");
    expect(job.prompt).toContain(`${TZ} dates`);
    expect(job.prompt).toMatch(/Never create, edit, transition or comment/);
    expect(job.prompt).toContain("OWN Jira activity");
    expect(job.prompt).toContain('updated >= "2026-11-08"');
  });
  it("validate closes over siteUrl", () => {
    const job = jiraActivityJob(range, { timeZone: TZ, siteUrl: SITE });
    const out = job.validate({ available: true, entries: [{ date: "2026-11-10", kind: "created", key: "ACME-1", summary: "x" }] });
    expect(out["2026-11-10"]!.entries[0]!.link).toBe(`${SITE}/browse/ACME-1`);
  });
});

describe("createJiraAgentActivity", () => {
  it("returns an agent source that runs the job without retrying worker errors", async () => {
    const calls: Array<{ kind: string; opts: unknown }> = [];
    const runner = { runJob: async (job: { kind: string }, opts: unknown) => (calls.push({ kind: job.kind, opts }), { ok: true }), status: () => ({}) } as unknown as Runner;
    const src = createJiraAgentActivity(runner, () => "small", { timeZone: TZ });
    expect(src.kind).toBe("agent");
    const r: JiraRange = range;
    await src.fetch(r);
    expect(calls[0]).toEqual({ kind: "worklog-jira", opts: { model: "small", timeoutMs: 600_000, retryOnWorkerError: false } });
  });
});

describe("jira identity", () => {
  const identity = { name: "Alex Doe", email: "alex@example.com", handles: { slack: "U0ALEX", github: "alexdoe" } };
  it("adds the identity line", () => {
    expect(jiraActivityJob(range, { timeZone: TZ, identity }).prompt).toContain("The user is Alex Doe (alex@example.com; Slack U0ALEX; GitHub @alexdoe). In meeting transcripts and notes, their lines are attributed to this name or email.");
    expect(jiraActivityJob(range, { timeZone: TZ }).prompt).not.toContain("The user is");
  });
});
