import { describe, expect, it } from "vitest";
import type { FeatureCtx } from "../lib/engine/extensions";
import { buildGhosts, bucketOf, candidates, citedKeys, clusterCandidates, labelFor, mergeWithExisting } from "../lib/features/ghost/radar";
import { claimGhost, dismissGhost, listGhosts, rebuildGhosts, setNotes } from "../lib/features/ghost/service";
import { register } from "../lib/features/ghost";
import { createRegistry } from "../lib/engine/extensions";
import { DEFAULT_FRAMEWORK } from "../lib/framework/default";
import { weekPlan } from "./fixtures";
import { DEFAULT_SETTINGS } from "../lib/settings";
import { createMemoryStore } from "../lib/storage/memory";
import { KIND } from "../lib/storage/port";
import { clusterHeadline, SURFACED_WHY } from "../components/radar/labels";
import { safeHref } from "../components/safeHref";
import { ghostClusterSchema, weekAddendaSchema, type EvidenceEntry, type GhostCluster, type Thread, type WorkDay, type WorkWeek } from "../lib/types";

const ok = { status: "ok", note: null } as const;
const PR = (n: number) => `https://github.com/acme/api/pull/${n}`;
const entry = (date: string, id: string, source: string, kind: string, what: string, link: string | null): EvidenceEntry => ({ id, date, source, kind, what, link, outcome: null, area: null });

function day(date: string, evidence: EvidenceEntry[], citedIds: string[] = []): WorkDay {
  const week = "x";
  return {
    version: 2, date, week, capturedAt: `${date}T22:00:00Z`, coverage: { github: ok }, meetings: [], meetingCount: 0, meetingMinutes: 0, evidence,
    rating: citedIds.length === 0 ? null : { rating: "meets", provisional: false, reason: "r", summary: "s", areas: [], evidenceIds: citedIds, ratedAt: `${date}T22:00:00Z`, model: null },
  };
}

function week(w: string, over: Partial<WorkWeek> = {}): WorkWeek {
  return {
    version: 2, week: w, from: "2026-11-02", to: "2026-11-06", generatedAt: "2026-11-06T23:00:00Z", model: null, final: true, rating: "meets", ratingReason: "",
    threeLines: [], days: [], daysWorked: 5, scorecard: [], shipped: [], inProgress: [], decisions: [], helping: [],
    meetings: { count: 0, hours: 0, pctOfWeek: 0, passiveCount: 0, topSinks: [] }, recognition: [], openAsks: [], friction: [], raiseWithManager: [],
    reflection: { goodWeek: true, text: "" }, coverage: {}, evidence: [], frameworkId: "default", areasSnapshot: [], plan: [], ext: {}, ...over,
  };
}

// Three weeks of reviews in acme/api: W44 (Oct 27), W45 (Nov 3), W46 (Nov 9).
const reviews = [
  entry("2026-10-28", "H1028-1", "github", "review", "Reviewed acme/api#1", PR(1)),
  entry("2026-11-03", "H1103-1", "github", "review", "Reviewed acme/api#2", PR(2)),
  entry("2026-11-04", "H1104-1", "github", "review", "Reviewed acme/api#3", PR(3)),
  entry("2026-11-09", "H1109-1", "github", "review", "Reviewed acme/api#4", PR(4)),
];
const days = [day("2026-10-28", [reviews[0]!]), day("2026-11-03", [reviews[1]!]), day("2026-11-04", [reviews[2]!]), day("2026-11-09", [reviews[3]!])];
const base = { days, weeks: [] as WorkWeek[], plans: [], threads: [] as Thread[] };

describe("candidates", () => {
  it("never includes evidence cited by a week claim, scorecard row, day rating or plan result", () => {
    const w = week("2026-W45", { shipped: [{ text: "x", evidenceIds: ["H1103-1"] }] });
    const w2 = week("2026-W46", { scorecard: [{ area: "delivery", status: "hit", note: "", evidenceIds: ["H1109-1"] }] });
    const rated = [day("2026-10-28", [reviews[0]!], ["H1028-1"]), ...days.slice(1)];
    const plan = weekPlan({ week: "2026-W45", results: [{ itemId: "a", status: "done" as const, note: "", evidenceIds: ["H1104-1"] }], hitRate: 1, judgedAt: "x" });
    const cited = citedKeys({ days: rated, weeks: [w, w2], plans: [plan] });
    expect([...cited].sort()).toEqual(["2026-W44:H1028-1", "2026-W45:H1103-1", "2026-W45:H1104-1", "2026-W46:H1109-1"]);
    expect(candidates({ days: rated, weeks: [w, w2], plans: [plan], threads: [] })).toEqual([]);
    expect(candidates(base).map((c) => c.id)).toEqual(["H1028-1", "H1103-1", "H1104-1", "H1109-1"]);
  });

  it("counts a cited id only in its own week", () => {
    const w = week("2026-W45", { shipped: [{ text: "x", evidenceIds: ["H1103-1"] }] });
    expect(candidates({ ...base, weeks: [w] }).map((c) => c.id)).toEqual(["H1028-1", "H1104-1", "H1109-1"]);
  });

  it("excludes thread-keyed evidence (by evidence id, link or key)", () => {
    const thread = (over: Partial<Thread>): Thread => ({ id: "t", title: "T", keys: [], weeks: [], firstWeek: "2026-W45", lastWeek: "2026-W45", status: "active", droppedReason: null, links: [], hidden: false, ...over });
    const byId = thread({ weeks: [{ week: "2026-W45", state: "in_progress", text: "", evidenceIds: ["H1103-1"] }] });
    const byLink = thread({ links: [PR(3)] });
    const byKey = thread({ keys: ["pr:acme/api#4"] });
    expect(candidates({ ...base, threads: [byId, byLink, byKey] }).map((c) => c.id)).toEqual(["H1028-1"]);
  });

  it("skips low-signal kinds", () => {
    const light = entry("2026-11-05", "H1105-1", "github", "review_light", "Looked at acme/api#9", PR(9));
    const meeting = entry("2026-11-05", "C1105-1", "calendar", "meeting", "Sync", null);
    expect(candidates({ ...base, days: [...days, day("2026-11-05", [light, meeting])] }).map((c) => c.id)).not.toContain("H1105-1");
    expect(candidates({ ...base, days: [...days, day("2026-11-05", [light, meeting])] }).map((c) => c.id)).not.toContain("C1105-1");
  });
});

describe("buckets", () => {
  it("buckets by repo, channel, doc, then kind", () => {
    expect(bucketOf({ source: "github", kind: "pr_merged", what: "x", link: "https://github.com/Acme/Api/pull/5" })).toBe("repo:acme/api");
    expect(bucketOf({ source: "slack", kind: "help_given", what: "#eng-help: unblocked", link: "https://x.slack.com/archives/C1/p1" })).toBe("channel:eng-help");
    expect(bucketOf({ source: "slack", kind: "thread_active", what: "unblocked", link: "https://x.slack.com/archives/C1/p1" })).toBe("channel:C1");
    expect(bucketOf({ source: "confluence", kind: "doc_edited", what: "x", link: "https://acme.atlassian.net/wiki/spaces/ENG/pages/42/ADR" })).toBe("doc:acme.atlassian.net/42");
    expect(bucketOf({ source: "granola", kind: "help_given", what: "x", link: null })).toBe("kind:help_given");
    expect(bucketOf({ source: "granola", kind: "decision", what: "x", link: null })).toBe("kind:decision");
    expect(bucketOf({ source: "jira", kind: "resolved", what: "x", link: "https://acme.atlassian.net/browse/A-1" })).toBeNull();
  });

  it("needs 3 items or 2 weeks", () => {
    const mk = (id: string, date: string, link: string) => entry(date, id, "github", "review", "r", link);
    const two = (a: string, b: string) => candidates({ ...base, days: [day(a, [mk("H1-1", a, PR(1))]), day(b, [mk("H2-1", b, PR(2))])] });
    expect(clusterCandidates(two("2026-11-03", "2026-11-04"))).toEqual([]); // 2 items, 1 week
    const c = clusterCandidates(two("2026-11-03", "2026-11-10"));
    expect(c).toHaveLength(1); // 2 items, 2 weeks
    expect(c[0]).toMatchObject({ bucket: "repo:acme/api", count: 2, weeks: ["2026-W45", "2026-W46"], state: "new", label: "2 code reviews in acme/api" });
    const three = candidates({ ...base, days: [day("2026-11-03", [mk("H1-1", "2026-11-03", PR(1)), mk("H1-2", "2026-11-03", PR(2)), mk("H1-3", "2026-11-03", PR(3))])] });
    expect(clusterCandidates(three)).toHaveLength(1); // 3 items, 1 week
  });
});

describe("radar labels", () => {
  it("direct-message and group buckets read as threads, never as #dm or #group; channels keep #name", () => {
    const items = [1, 2, 3].map(() => ({ kind: "help_given" }));
    expect(labelFor("channel:dm", items)).toBe("3 direct-message threads");
    expect(labelFor("channel:group", items)).toBe("3 group-message threads");
    expect(labelFor("channel:dm", items.slice(0, 1))).toBe("1 direct-message thread");
    expect(labelFor("channel:eng-help", items)).toBe("3 times helping others in #eng-help");
    expect(labelFor("channel:dm", items) + labelFor("channel:group", items)).not.toContain("#");
  });
  it("every card says why it surfaced, and links are https only", () => {
    expect(SURFACED_WHY).toBe("Not mentioned in any weekly summary");
    expect(clusterHeadline({ label: "6 code reviews in acme/api", weeks: ["a", "b", "c"] })).toBe("6 code reviews in acme/api, over 3 weeks");
    expect(safeHref("https://github.com/acme/api/pull/1")).toBe("https://github.com/acme/api/pull/1");
    for (const bad of ["javascript:alert(1)", "http://x.test", "data:text/html,x", "//x.test", "/rel", "", null, undefined, " https://x.test"]) expect(safeHref(bad)).toBeUndefined();
  });
});

describe("dedupe", () => {
  it("keeps a dismissed cluster dismissed as it grows", () => {
    const first = buildGhosts({ ...base, days: days.slice(0, 3) }, []).clusters;
    expect(first).toHaveLength(1);
    const dismissed: GhostCluster = { ...first[0]!, state: "dismissed" };
    const grown = buildGhosts(base, [dismissed]);
    expect(grown.clusters).toHaveLength(1);
    expect(grown.clusters[0]).toMatchObject({ id: dismissed.id, state: "dismissed", count: 4 });
    expect(grown.remove).toEqual([]);
  });

  it("starts a separate cluster below 50% overlap and drops unmatched new ones", () => {
    const fresh = clusterCandidates(candidates(base));
    const unrelated: GhostCluster = { ...fresh[0]!, id: "gh-old", bucket: "repo:other/x", items: [{ date: "2026-01-05", id: "H0105-1", link: null, week: "2026-W02", kind: "review", what: "w" }], count: 1, state: "new" };
    const merged = mergeWithExisting(fresh, [unrelated]);
    expect(merged.remove).toEqual(["gh-old"]);
    expect(merged.clusters.map((c) => c.id)).toEqual([fresh[0]!.id]);
    const kept = mergeWithExisting(fresh, [{ ...unrelated, state: "dismissed" }]);
    expect(kept.clusters.map((c) => c.state).sort()).toEqual(["dismissed", "new"]);
  });
});

describe("service", () => {
  function harness() {
    const store = createMemoryStore();
    const published: number[] = [];
    const ctx: FeatureCtx = {
      store, settings: () => ({ ...DEFAULT_SETTINGS, timeZone: "America/New_York" }), framework: async () => DEFAULT_FRAMEWORK,
      runner: { runJob: async () => { throw new Error("no jobs"); }, status: () => ({ running: 0, queued: 0 }) },
      log: { info: () => undefined, warn: () => undefined }, publish: () => void published.push(1), now: () => new Date("2026-11-13T22:00:00Z"),
    };
    return { store, ctx, published };
  }

  it("rebuilds into ghost records through the week hook", async () => {
    const { store, ctx } = harness();
    for (const d of days) await store.set(KIND.day, d.date, d);
    const reg = createRegistry();
    register(reg);
    await reg.weekHooks[0]!.afterWeekSaved(week("2026-W46"), ctx);
    const rows = await store.list(KIND.ghost, ghostClusterSchema);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toMatchObject({ bucket: "repo:acme/api", count: 4, weeks: ["2026-W44", "2026-W45", "2026-W46"] });
  });

  it("claim writes the addenda record, keeps notes and marks the cluster claimed", async () => {
    const { store, ctx } = harness();
    for (const d of days) await store.set(KIND.day, d.date, d);
    const [cluster] = await rebuildGhosts(ctx, "2026-W46");
    await setNotes(ctx, "2026-W46", "my notes");
    await claimGhost(ctx, { id: cluster!.id, as: "note", week: "2026-W46", text: "Code review in acme/api" });
    const addenda = await store.get(KIND.addenda, "2026-W46", weekAddendaSchema);
    expect(addenda?.myNotes).toBe("my notes");
    expect(addenda?.claimedWork).toEqual([{ text: "Code review in acme/api", evidenceIds: ["H1028-1", "H1103-1", "H1104-1", "H1109-1"] }]);
    expect(addenda?.raiseWithManager).toEqual([]);
    expect(await store.get(KIND.ghost, cluster!.id, ghostClusterSchema)).toMatchObject({ state: "claimed", claimedAs: "note", claimedWeek: "2026-W46" });
    // setNotes keeps the claims; a rebuild keeps the claimed state.
    await setNotes(ctx, "2026-W46", "changed");
    expect((await store.get(KIND.addenda, "2026-W46", weekAddendaSchema))?.claimedWork).toHaveLength(1);
    await rebuildGhosts(ctx, "2026-W46");
    expect((await listGhosts(ctx, 8))[0]).toMatchObject({ id: cluster!.id, state: "claimed" });
    await expect(claimGhost(ctx, { id: cluster!.id, as: "raise", week: "2026-W46", text: "again" })).rejects.toThrow(/already claimed/);
  });

  it("raise goes to raiseWithManager; dismiss marks dismissed", async () => {
    const { store, ctx } = harness();
    for (const d of days) await store.set(KIND.day, d.date, d);
    const [cluster] = await rebuildGhosts(ctx, "2026-W46");
    await claimGhost(ctx, { id: cluster!.id, as: "raise", week: "2026-W46", text: "" });
    expect((await store.get(KIND.addenda, "2026-W46", weekAddendaSchema))?.raiseWithManager[0]?.text).toBe("4 code reviews in acme/api");
    await dismissGhost(ctx, cluster!.id);
    expect((await store.get(KIND.ghost, cluster!.id, ghostClusterSchema))?.state).toBe("dismissed");
  });

  it("ghost.list builds on first use and limits to the requested weeks", async () => {
    const { store, ctx } = harness();
    for (const d of days) await store.set(KIND.day, d.date, d);
    expect(await listGhosts(ctx, 8)).toHaveLength(1);
    expect(await listGhosts(ctx, 1)).toHaveLength(1); // W46 is the current week and is in the cluster
  });
});
