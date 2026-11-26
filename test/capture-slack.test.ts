import { describe, expect, it } from "vitest";
import { validateSlackActivity, worklogSlackJob } from "../lib/capture/slack";

const D = "2026-11-09";
const TZ = "America/New_York";

describe("validateSlackActivity", () => {
  const item = (over: Record<string, unknown> = {}) => ({ kind: "help_given", channel: "eng-help", what: "Unblocked Sam on the migration", outcome: "Merged", url: "https://x.slack.com/archives/C1/p1", ts: "1", posts: 4, ...over });

  it("maps items, prefixes the channel and dedupes by url", () => {
    const out = validateSlackActivity({ available: true, note: null, items: [item(), item({ what: "dupe" }), item({ url: "https://x.slack.com/archives/C1/p2", kind: "watched_channel", channel: "#eng-leads" })] }, D);
    expect(out.entries).toHaveLength(2);
    expect(out.entries[0]).toMatchObject({ source: "slack", kind: "help_given", what: "#eng-help: Unblocked Sam on the migration", link: "https://x.slack.com/archives/C1/p1" });
    expect(out.entries[1]).toMatchObject({ kind: "watched_channel" });
    expect(out.entries[1]!.what.startsWith("#eng-leads: ")).toBe(true);
    expect(out.coverage.status).toBe("ok");
  });

  it("rejects a kind the source does not know (imports map those through normalizeKind instead)", () => {
    expect(() => validateSlackActivity({ available: true, items: [item({ kind: "legacy_channel" })] }, D)).toThrow(/kind/);
  });

  it("throws on a bad kind or url and reports unavailability", () => {
    expect(() => validateSlackActivity({ available: true, items: [item({ kind: "gossip" })] }, D)).toThrow(/kind/);
    expect(() => validateSlackActivity({ available: true, items: [item({ url: "javascript:x" })] }, D)).toThrow(/url/);
    expect(validateSlackActivity({ available: false, note: "not signed in", items: [] }, D).coverage.status).toBe("failed");
  });

  it("caps at 25 entries", () => {
    const items = Array.from({ length: 40 }, (_, i) => item({ url: `https://x.slack.com/archives/C1/p${i}` }));
    expect(validateSlackActivity({ available: true, items }, D).entries).toHaveLength(25);
  });
});

describe("worklogSlackJob prompt", () => {
  it("carries the date, zone, the read-only rule and the search guidance", () => {
    const { prompt } = worklogSlackJob(D, { timeZone: TZ, watchedChannels: ["eng-leads", "#eng-help"] });
    expect(prompt).toContain(D);
    expect(prompt).toContain(TZ);
    expect(prompt).toMatch(/Never post, react/);
    expect(prompt).toMatch(/ALL channel types/);
    expect(prompt).toContain("from:<@ME>");
    expect(prompt).toContain("to:<@ME>");
    expect(prompt).toMatch(/One item per thread/);
  });

  it("lists the watched channels as the last list item, normalising the leading #", () => {
    const { prompt } = worklogSlackJob(D, { timeZone: TZ, watchedChannels: ["eng-leads", "#eng-help"] });
    expect(prompt).toContain('"#eng-leads", "#eng-help"');
    expect(prompt).toMatch(/6\. anything the user posted in these watched channels.*"watched_channel"\)\./);
  });

  it("with no watched channels, drops the channel list item entirely and names no channel", () => {
    for (const watchedChannels of [[], ["", "  "]]) {
      const { prompt } = worklogSlackJob(D, { timeZone: TZ, watchedChannels });
      expect(prompt).not.toContain("watched_channel");
      expect(prompt).not.toMatch(/watched channels/i);
      expect(prompt).not.toContain("6.");
      expect(prompt).toMatch(/5\. decisions the user made or drove in a thread \("decision"\)\./);
    }
  });
});

describe("settings sanitising", () => {
  it("drops watched channel names that are not plain names", () => {
    const { prompt } = worklogSlackJob(D, { timeZone: TZ, watchedChannels: ["#ok-one", 'bad"name', "two words", "line\nbreak", "x".repeat(81), "fine_2.0"] });
    expect(prompt).toContain('"#ok-one", "#fine_2.0"');
    for (const bad of ['bad"name', "two words", "break", "xxxxxxxx"]) expect(prompt).not.toContain(bad);
  });
});

describe("slack identity", () => {
  const identity = { name: "Alex Doe", email: "alex@example.com", handles: { slack: "U0ALEX", github: "alexdoe" } };
  it("adds the identity line", () => {
    expect(worklogSlackJob(D, { timeZone: TZ, watchedChannels: [], identity }).prompt).toContain("The user is Alex Doe (alex@example.com; Slack U0ALEX; GitHub @alexdoe). In meeting transcripts and notes, their lines are attributed to this name or email.");
    expect(worklogSlackJob(D, { timeZone: TZ, watchedChannels: [] }).prompt).not.toContain("The user is");
  });
});
