import { describe, expect, it } from "vitest";
import { buildGrid } from "../lib/engine/grid";
import { createRegistry, type FeatureCtx } from "../lib/engine/extensions";
import { buildThreads, isOlderThread, lifecycleStatus, needClosureIds, wantsClosureNote, type ThreadWeekInput } from "../lib/features/threads/build";
import { extractKeys, keyOfLink } from "../lib/features/threads/keys";
import { register, saveClosureDrafts } from "../lib/features/threads";
import { createClosureDraftsPrompt, MAX_DRAFTS, validateClosureDrafts } from "../lib/features/threads/drafts";
import { handlers } from "../lib/handlers/threads";
import { DEFAULT_FRAMEWORK } from "../lib/framework/default";
import { DEFAULT_SETTINGS } from "../lib/settings";
import { createMemoryStore } from "../lib/storage/memory";
import { KIND } from "../lib/storage/port";
import { closureNoteSchema, workWeekSchema, type ClosureNote, type ThreadEdit } from "../lib/types";

const NOW = "2026-11-13T15:00:00.000Z";
const JIRA = (k: string) => `https://acme.atlassian.net/browse/${k}`;
const PR = (n: number) => `https://github.com/Acme/Widgets/pull/${n}`;

/** A week where each claim cites one evidence entry carrying `link`. */
function week(w: string, shipped: Array<[string, string | null]> = [], inProgress: Array<[string, string | null]> = []): ThreadWeekInput {
  const evidence: ThreadWeekInput["evidence"] = [];
  const claim = ([text, link]: [string, string | null], i: number, p: string) => {
    const id = `${p}${w.slice(-2)}${String(i).padStart(2, "0")}-1`;
    evidence.push({ id, date: "2026-11-09", source: "x", kind: "k", what: text, link, outcome: null, area: null });
    return { text, evidenceIds: [id] };
  };
  return { week: w, shipped: shipped.map((c, i) => claim(c, i, "G")), inProgress: inProgress.map((c, i) => claim(c, i, "J")), evidence };
}
const edit = (threadId: string, over: Partial<ThreadEdit> = {}): ThreadEdit => ({ threadId, title: null, mergeInto: null, hidden: null, extraKeys: [], drop: null, ...over });
const closure = (threadId: string): ClosureNote => ({ threadId, outcome: "as_expected", expectation: "e", result: "r", learnings: "l", source: "user", at: NOW });
const byKey = (threads: ReturnType<typeof buildThreads>, key: string) => threads.find((t) => t.keys.includes(key))!;

describe("extractKeys", () => {
  it("recognises Jira browse URLs", () => {
    expect(keyOfLink("https://acme.atlassian.net/browse/abc-12?focusedId=3")).toBe("jira:ABC-12");
    expect(keyOfLink("https://acme.atlassian.net/jira/software/projects/ABC/boards/4?selectedIssue=ABC-77")).toBe("jira:ABC-77");
  });
  it("recognises GitHub pull request URLs", () => {
    expect(keyOfLink("https://github.com/Acme/Widgets/pull/5/files")).toBe("pr:acme/widgets#5");
    expect(keyOfLink("https://github.com/acme/widgets/issues/5")).toBeNull();
  });
  it("recognises Confluence pages", () => {
    expect(keyOfLink("https://acme.atlassian.net/wiki/spaces/ENG/pages/123456/Design+notes")).toBe("doc:acme.atlassian.net/123456");
    expect(keyOfLink("https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=987")).toBe("doc:acme.atlassian.net/987");
  });
  it("recognises Google Docs, Sheets and Slides", () => {
    expect(keyOfLink("https://docs.google.com/document/d/1AbC_dEf-9/edit")).toBe("doc:docs.google.com/1AbC_dEf-9");
    expect(keyOfLink("https://docs.google.com/spreadsheets/d/zzz111/edit#gid=0")).toBe("doc:docs.google.com/zzz111");
  });
  it("ignores other links, bad URLs and null; dedupes in order", () => {
    expect(keyOfLink("https://example.com/browse/ABC-1x")).toBeNull();
    expect(keyOfLink("not a url")).toBeNull();
    expect(extractKeys([null, undefined, "", JIRA("A-1"), PR(2), JIRA("A-1"), "https://example.com"])).toEqual(["jira:A-1", "pr:acme/widgets#2"]);
  });
});

describe("buildThreads: grouping", () => {
  it("two weeks sharing a key form one thread, across link kinds", () => {
    const t = buildThreads(
      [week("2026-W44", [], [["Start cache work", JIRA("ABC-1")]]), week("2026-W45", [["Cache merged", PR(9)]], [["More cache", JIRA("ABC-1")]])],
      [], [], "2026-W45",
    );
    expect(t).toHaveLength(2); // the PR claim has no shared key yet
    const joined = buildThreads(
      [week("2026-W44", [], [["Start cache work", JIRA("ABC-1")]]), week("2026-W45", [["Cache work shipped", JIRA("ABC-1")]])],
      [], [], "2026-W45",
    );
    expect(joined).toHaveLength(1);
    expect(joined[0]).toMatchObject({ id: "th:jira:ABC-1", firstWeek: "2026-W44", lastWeek: "2026-W45", keys: ["jira:ABC-1"] });
    expect(joined[0]!.weeks.map((w) => [w.week, w.state])).toEqual([["2026-W44", "in_progress"], ["2026-W45", "shipped"]]);
    expect(joined[0]!.links).toEqual([JIRA("ABC-1")]);
  });
  it("a claim with two keys bridges two threads", () => {
    const wk = week("2026-W45", [], []);
    wk.inProgress.push({ text: "Bridge", evidenceIds: ["B1", "B2"] });
    wk.evidence.push({ id: "B1", date: "2026-11-09", source: "x", kind: "k", what: "a", link: JIRA("A-1"), outcome: null, area: null }, { id: "B2", date: "2026-11-09", source: "x", kind: "k", what: "b", link: PR(4), outcome: null, area: null });
    const t = buildThreads([week("2026-W44", [], [["PR work", PR(4)]]), week("2026-W43", [], [["Ticket", JIRA("A-1")]]), wk], [], [], "2026-W45");
    expect(t).toHaveLength(1);
    expect(t[0]!.keys.sort()).toEqual(["jira:A-1", "pr:acme/widgets#4"]);
  });
  it("a keyless claim is a one-week thread only when it shipped", () => {
    const t = buildThreads([week("2026-W45", [["Fixed the flaky test", null]], [["Thinking about X", null]])], [], [], "2026-W45");
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ title: "Fixed the flaky test", keys: [], firstWeek: "2026-W45", lastWeek: "2026-W45", status: "shipped" });
  });
  it("uses the evidence ids a claim cites, and keeps them on the thread weeks", () => {
    const t = buildThreads([week("2026-W45", [["Done", JIRA("A-2")]])], [], [], "2026-W45");
    expect(t[0]!.weeks[0]!.evidenceIds).toEqual(["G4500-1"]);
  });
});

describe("buildThreads: status rules", () => {
  it("active: in progress recently", () => {
    const t = buildThreads([week("2026-W45", [], [["Work", JIRA("A-1")]])], [], [], "2026-W46");
    expect(t[0]!.status).toBe("active");
  });
  it("at_risk: in progress 4 consecutive weeks with nothing shipped", () => {
    const four = ["2026-W43", "2026-W44", "2026-W45", "2026-W46"].map((w) => week(w, [], [["Slow burn", JIRA("A-1")]]));
    expect(buildThreads(four, [], [], "2026-W46")[0]!.status).toBe("at_risk");
    expect(buildThreads(four.slice(1), [], [], "2026-W46")[0]!.status).toBe("active");
    // a gap breaks the run
    const gap = [four[0]!, four[2]!, four[3]!];
    expect(buildThreads(gap, [], [], "2026-W46")[0]!.status).toBe("active");
  });
  it("at_risk needs nothing shipped in the run", () => {
    const weeks = ["2026-W43", "2026-W44", "2026-W45", "2026-W46"].map((w, i) => week(w, i === 2 ? [["Part shipped", JIRA("A-1")]] : [], [["Slow burn", JIRA("A-1")]]));
    expect(buildThreads(weeks, [], [], "2026-W46")[0]!.status).toBe("active");
  });
  it("shipped: shipped with no closure note, however long ago, but only recent substantial work prompts", () => {
    const old = buildThreads([week("2026-W30", [["Shipped", JIRA("A-1")]])], [], [], "2026-W46");
    expect(old[0]!.status).toBe("shipped");
    expect(needClosureIds(old, "2026-W46")).toEqual([]);
    // keyed + in-progress history + shipped within 4 weeks
    const recent = buildThreads([week("2026-W44", [], [["Build", JIRA("A-1")]]), week("2026-W45", [["Shipped", JIRA("A-1")]])], [], [], "2026-W46");
    expect(needClosureIds(recent, "2026-W46")).toEqual(["th:jira:A-1"]);
    // ... but not once the ship is more than 4 weeks back
    expect(needClosureIds(recent, "2026-W50")).toEqual([]);
    expect(needClosureIds(recent, "2026-W49")).toEqual(["th:jira:A-1"]);
  });
  it("a one-week shipped claim, even a recent one, does not prompt; two weeks without a key do", () => {
    const one = buildThreads([week("2026-W45", [["Shipped", JIRA("A-1")]])], [], [], "2026-W46");
    expect(needClosureIds(one, "2026-W46")).toEqual([]);
    expect(wantsClosureNote(one[0]!, "2026-W46")).toBe(false);
    const two = buildThreads([week("2026-W44", [], [["Build the cache", null]]), week("2026-W45", [["Cache shipped", null]], [["Build the cache", null]])], [], [], "2026-W46");
    expect(two.length).toBeGreaterThan(0);
    for (const t of two) expect(wantsClosureNote(t, "2026-W46")).toBe(t.status === "shipped" && new Set(t.weeks.map((w) => w.week)).size >= 2);
  });
  it("30 one-week shipped claims from over 4 weeks ago produce no closure prompts and are older", () => {
    const weeks = Array.from({ length: 30 }, (_, i) => week(`2026-W${String(1 + i).padStart(2, "0")}`, [[`Shipped thing ${i}`, JIRA(`K-${i + 1}`)]]));
    const t = buildThreads(weeks, [], [], "2026-W40");
    expect(t).toHaveLength(30);
    expect(t.every((x) => x.status === "shipped")).toBe(true);
    expect(needClosureIds(t.filter((x) => x.lastWeek < "2026-W34"), "2026-W40")).toEqual([]);
    expect(t.filter((x) => x.lastWeek < "2026-W35").every((x) => isOlderThread(x, "2026-W40"))).toBe(true);
  });
  it("isOlderThread keeps active and at-risk threads in the default view", () => {
    const t = buildThreads([week("2026-W30", [], [["Slow", JIRA("A-1")]])], [], [], "2026-W46")[0]!;
    expect(t.status).toBe("stale");
    expect(isOlderThread(t, "2026-W46")).toBe(true);
    expect(isOlderThread({ ...t, status: "at_risk" }, "2026-W46")).toBe(false);
    expect(isOlderThread({ ...t, status: "active" }, "2026-W46")).toBe(false);
  });
  it("closed: has a closure", () => {
    const t = buildThreads([week("2026-W45", [["Shipped", JIRA("A-1")]])], [], [closure("th:jira:A-1")], "2026-W46");
    expect(t[0]!.status).toBe("closed");
    expect(needClosureIds(t, "2026-W46")).toEqual([]);
  });
  it("stale: no claim for 3 weeks", () => {
    const w = [week("2026-W42", [], [["Quiet", JIRA("A-1")]])];
    expect(buildThreads(w, [], [], "2026-W44")[0]!.status).toBe("active");
    expect(buildThreads(w, [], [], "2026-W45")[0]!.status).toBe("stale");
    expect(buildThreads(w, [], [], "2026-W46")[0]!.status).toBe("stale");
  });
  it("work resumed after a ship is active again, not awaiting a note", () => {
    const t = buildThreads([week("2026-W43", [["Shipped v1", JIRA("A-1")]]), week("2026-W45", [], [["v2", JIRA("A-1")]])], [], [], "2026-W46");
    expect(t[0]!.status).toBe("active");
  });
  it("lifecycleStatus handles year boundaries", () => {
    expect(lifecycleStatus([{ week: "2026-W52", state: "in_progress" }, { week: "2026-W53", state: "in_progress" }, { week: "2027-W01", state: "in_progress" }, { week: "2027-W02", state: "in_progress" }], "2027-W02")).toBe("at_risk");
  });
});

describe("buildThreads: edits and rebuilds", () => {
  const weeks = [week("2026-W44", [], [["Part A", JIRA("A-1")]]), week("2026-W45", [["Part B shipped", JIRA("B-1")]], [["Other", JIRA("C-1")]])];
  it("merge and hide edits survive a rebuild, including after a new claim lands", () => {
    const edits = [edit("th:jira:B-1", { mergeInto: "th:jira:A-1" }), edit("th:jira:C-1", { hidden: true, title: "Renamed" })];
    const first = buildThreads(weeks, edits, [], "2026-W45");
    expect(first).toHaveLength(2);
    const merged = byKey(first, "jira:B-1");
    expect(merged.keys.sort()).toEqual(["jira:A-1", "jira:B-1"]);
    expect(merged.id).toBe("th:jira:A-1");
    const hidden = byKey(first, "jira:C-1");
    expect(hidden).toMatchObject({ hidden: true, title: "Renamed" });
    const later = buildThreads([...weeks, week("2026-W46", [], [["More B", JIRA("B-1")]])], edits, [], "2026-W46");
    expect(later).toHaveLength(2);
    expect(byKey(later, "jira:B-1").id).toBe("th:jira:A-1");
    expect(byKey(later, "jira:C-1").hidden).toBe(true);
  });
  it("a closure written under a merged-away id still applies", () => {
    const t = buildThreads(weeks, [edit("th:jira:B-1", { mergeInto: "th:jira:A-1" })], [closure("th:jira:B-1")], "2026-W45");
    expect(byKey(t, "jira:A-1").status).toBe("closed");
  });
  it("extraKeys pull other threads in and are kept on the thread", () => {
    const t = buildThreads(weeks, [edit("th:jira:A-1", { extraKeys: ["jira:C-1", "doc:docs.google.com/xyz"] })], [], "2026-W45");
    expect(byKey(t, "jira:A-1").keys).toEqual(expect.arrayContaining(["jira:A-1", "jira:C-1", "doc:docs.google.com/xyz"]));
    expect(t).toHaveLength(2);
  });
  it("a drop edit with a reason makes the thread dropped; an empty reason is ignored", () => {
    const dropped = buildThreads(weeks, [edit("th:jira:A-1", { drop: { reason: "Superseded by B" } })], [], "2026-W45");
    expect(byKey(dropped, "jira:A-1")).toMatchObject({ status: "dropped", droppedReason: "Superseded by B" });
    const blank = buildThreads(weeks, [edit("th:jira:A-1", { drop: { reason: "  " } })], [], "2026-W45");
    expect(byKey(blank, "jira:A-1").status).toBe("active");
  });
  it("hidden threads never need a closure note", () => {
    const t = buildThreads(weeks, [edit("th:jira:B-1", { hidden: true })], [], "2026-W45");
    expect(needClosureIds(t, "2026-W45")).toEqual([]);
  });
});

function harness(weeks: ThreadWeekInput[] = []) {
  const store = createMemoryStore();
  const ctx: FeatureCtx = {
    store,
    settings: () => ({ ...DEFAULT_SETTINGS, timeZone: "America/New_York" }),
    framework: async () => DEFAULT_FRAMEWORK,
    runner: {} as FeatureCtx["runner"],
    log: { info: () => undefined, warn: () => undefined },
    publish: () => undefined,
    now: () => new Date(NOW),
  };
  const reg = createRegistry();
  register(reg);
  const api = handlers(ctx, {} as never, {} as never);
  const seed = async (list: ThreadWeekInput[]) => {
    for (const w of list) {
      await store.set(
        KIND.week,
        w.week,
        workWeekSchema.parse({
          version: 2, week: w.week, from: "2026-11-09", to: "2026-11-13", generatedAt: NOW, model: null, final: true, rating: "meets", ratingReason: "r", threeLines: [], days: [], daysWorked: 5,
          scorecard: [], meetings: { count: 0, hours: 0, pctOfWeek: 0, passiveCount: 0 }, reflection: { goodWeek: true, text: "t" }, coverage: {}, shipped: w.shipped, inProgress: w.inProgress, evidence: w.evidence,
        }),
      );
    }
  };
  return { store, ctx, reg, api, seed, weeks };
}

describe("handlers and hooks", () => {
  const data = [week("2026-W44", [], [["Build it", JIRA("A-1")]]), week("2026-W45", [["Shipped it", JIRA("A-1")]], [["Building other", JIRA("B-1")]]), week("2026-W46", [["Shipped other", JIRA("B-1")]])];

  it("a shipped thread without a closure is in needClosure; closure.set clears it", async () => {
    const { api, seed, store, reg, ctx } = harness();
    await seed(data);
    const before = await api["threads.list"]({ weeks: 36 });
    expect(before.needClosure.sort()).toEqual(["th:jira:A-1", "th:jira:B-1"]);
    await api["closure.set"]({ threadId: "th:jira:A-1", outcome: "better", expectation: "Done in a week", result: "Took two, and paid off", learnings: "Slice smaller", impact: " Cut p95 by 30% " });
    const after = await api["threads.list"]({ weeks: 36 });
    expect(after.needClosure).toEqual(["th:jira:B-1"]);
    expect(after.closures).toEqual([expect.objectContaining({ threadId: "th:jira:A-1", outcome: "better", impact: "Cut p95 by 30%", at: NOW })]);
    expect(after.threads.find((t) => t.id === "th:jira:A-1")!.status).toBe("closed");
    // the derived record was stored for other features
    expect((await store.list(KIND.threads, (await import("../lib/features/threads/service")).derivedThreadsSchema))[0]!.id).toBe("derived");

    // the week hook rebuilds it and the grid contributor marks the weeks
    await reg.weekHooks[0]!.afterWeekSaved({ week: "2026-W46", ext: {}, shipped: [] } as never, ctx);
    const grid = buildGrid({ version: 2, days: {}, weeks: {} }, "2026-11-13", 4, { running: null, queued: [], lastError: null }, { areas: [], timeZone: "America/New_York", workdayHours: 8 });
    await reg.grid[0]!.contribute(grid, ctx);
    const m = (w: string) => grid.weeks.find((x) => x.week === w)!.markers;
    expect([m("2026-W44").shipped, m("2026-W45").shipped, m("2026-W46").shipped]).toEqual([0, 1, 1]);
    expect([m("2026-W45").needClosure, m("2026-W46").needClosure]).toEqual([0, 1]);
  });

  it("threads.edit requires a reason to drop, rejects unknown threads, and merges survive", async () => {
    const { api, seed } = harness();
    await seed(data);
    await expect(api["threads.edit"]({ threadId: "th:jira:B-1", title: null, mergeInto: null, hidden: null, extraKeys: [], drop: { reason: "  " } })).rejects.toThrow(/reason/);
    await expect(api["threads.edit"]({ threadId: "nope", title: null, mergeInto: null, hidden: true, extraKeys: [], drop: null })).rejects.toThrow(/Unknown/);
    await expect(api["threads.edit"]({ threadId: "th:jira:B-1", title: null, mergeInto: "th:jira:B-1", hidden: null, extraKeys: [], drop: null })).rejects.toThrow(/itself/);
    await api["threads.edit"]({ threadId: "th:jira:B-1", title: "Other work", mergeInto: "th:jira:A-1", hidden: null, extraKeys: [], drop: null });
    await api["threads.edit"]({ threadId: "th:jira:A-1", title: null, mergeInto: null, hidden: true, extraKeys: [], drop: null });
    const list = await api["threads.list"]({ weeks: 36 });
    expect(list.threads).toHaveLength(1);
    expect(list.threads[0]).toMatchObject({ id: "th:jira:A-1", title: "Other work", hidden: true });
    expect(list.needClosure).toEqual([]);
    await api["threads.edit"]({ threadId: "th:jira:A-1", title: null, mergeInto: null, hidden: null, extraKeys: [], drop: { reason: "Not pursued" } });
    expect((await api["threads.list"]({ weeks: 36 })).threads[0]).toMatchObject({ status: "dropped", droppedReason: "Not pursued", hidden: true });
  });

  it("threads.list windows by last claim week", async () => {
    const { api, seed } = harness();
    await seed([week("2026-W10", [["Old", JIRA("O-1")]]), ...data]);
    expect((await api["threads.list"]({ weeks: 36 })).threads.map((t) => t.id)).not.toContain("th:jira:O-1");
    expect((await api["threads.list"]({ weeks: 52 })).threads.map((t) => t.id)).toContain("th:jira:O-1");
  });
});

describe("validateClosureDrafts", () => {
  const ids = new Set(["G4500-1", "G4501-1"]);
  const draft = (over: Record<string, unknown> = {}) => ({ threadKey: "Cache work shipped", outcome: "better", expectation: "Done in a week", result: "Took two, p95 halved", learnings: "Slice smaller", evidenceIds: ["G4500-1"], ...over });
  const raw = (drafts: unknown[], shipped: string[] = ["Cache work shipped", "Queue rewrite shipped"]) => ({ shipped: shipped.map((text) => ({ text, evidenceIds: [] })), closureDrafts: drafts });

  it("keeps a complete draft that names a shipped entry and cites known evidence", () => {
    expect(validateClosureDrafts(raw([draft({ impact: " Cut p95 by half " })]), ids)).toEqual([
      { claimText: "Cache work shipped", outcome: "better", expectation: "Done in a week", result: "Took two, p95 halved", learnings: "Slice smaller", impact: "Cut p95 by half", evidenceIds: ["G4500-1"] },
    ]);
  });
  it("matches the shipped entry loosely, and defaults a bad outcome to as_expected", () => {
    const out = validateClosureDrafts(raw([draft({ threadKey: "  cache WORK shipped ", outcome: "amazing" })]), ids);
    expect(out[0]).toMatchObject({ claimText: "Cache work shipped", outcome: "as_expected" });
  });
  it("never binds by substring: a generic key like \"fix\" matches nothing, even when it is part of a shipped entry", () => {
    const shipped = [{ text: "Fix login redirect", evidenceIds: ["G4500-1"] }, { text: "Fix cache eviction", evidenceIds: ["G4501-1"] }];
    expect(validateClosureDrafts({ shipped, closureDrafts: [draft({ threadKey: "fix", evidenceIds: [] })] }, ids)).toEqual([]);
    expect(validateClosureDrafts({ shipped, closureDrafts: [draft({ threadKey: "fix", evidenceIds: ["G4500-1", "G4501-1"] })] }, ids)).toEqual([]);
  });
  it("falls back to the one shipped entry that shares evidence ids with the draft", () => {
    const shipped = [{ text: "Fix login redirect", evidenceIds: ["G4500-1"] }, { text: "Fix cache eviction", evidenceIds: ["G4501-1"] }];
    const out = validateClosureDrafts({ shipped, closureDrafts: [draft({ threadKey: "fix", evidenceIds: ["G4501-1"] })] }, ids);
    expect(out[0]).toMatchObject({ claimText: "Fix cache eviction" });
  });
  it("drops drafts with no shipped match, no known evidence, or a missing expectation, result or learnings", () => {
    const out = validateClosureDrafts(
      raw([
        draft({ threadKey: "Something never shipped" }),
        draft({ evidenceIds: ["nope"] }),
        draft({ evidenceIds: [] }),
        draft({ expectation: " " }),
        draft({ result: "" }),
        draft({ learnings: undefined }),
        "junk",
        null,
      ]),
      ids,
    );
    expect(out).toEqual([]);
  });
  it("drops unknown evidence ids but keeps the draft, keeps the first draft per claim, and caps the count", () => {
    const out = validateClosureDrafts(raw([draft({ evidenceIds: ["G4500-1", "nope"] }), draft({ result: "second" })]), ids);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ evidenceIds: ["G4500-1"], result: "Took two, p95 halved" });
    const shipped = Array.from({ length: 9 }, (_, i) => `Shipped ${i}`);
    expect(validateClosureDrafts(raw(shipped.map((t) => draft({ threadKey: t })), shipped), ids)).toHaveLength(MAX_DRAFTS);
  });
  it("is empty without a closureDrafts array", () => {
    expect(validateClosureDrafts({ shipped: [] }, ids)).toEqual([]);
    expect(validateClosureDrafts({ closureDrafts: "x" }, ids)).toEqual([]);
  });
  it("the prompt extension validates against the week's own evidence ids", async () => {
    const { store, ctx } = harness();
    await store.set(KIND.day, "2026-11-09", { version: 2, date: "2026-11-09", week: "2026-W46", capturedAt: NOW, coverage: {}, meetings: [], meetingCount: 0, meetingMinutes: 0, evidence: [{ id: "G1109-1", date: "2026-11-09", source: "x", kind: "k", what: "w", link: null, outcome: null, area: null }], rating: null });
    const ext = createClosureDraftsPrompt();
    const pctx = { week: "2026-W46", dates: ["2026-11-09"], framework: DEFAULT_FRAMEWORK, settings: ctx.settings(), store };
    expect(await ext.weekRules!(pctx)).toContain("CLOSURE DRAFTS");
    const out = ext.validateWeekExtra!(raw([draft({ evidenceIds: ["G1109-1", "G4500-1"] })]), pctx) as Array<{ evidenceIds: string[] }>;
    expect(out[0]!.evidenceIds).toEqual(["G1109-1"]);
  });
});

describe("saveClosureDrafts", () => {
  const data = [week("2026-W44", [], [["Start cache work", JIRA("A-1")]]), week("2026-W45", [["Cache work shipped", JIRA("A-1")]])];
  const draftFor = (over: Record<string, unknown> = {}) => ({ claimText: "Cache work shipped", outcome: "better", expectation: "Done in a week", result: "Took two", learnings: "Slice smaller", evidenceIds: ["G4500-1"], ...over });
  const weekArg = (drafts: unknown[]) => ({ week: "2026-W45", shipped: [{ text: "Cache work shipped", evidenceIds: ["G4500-1"] }], ext: { closures: drafts } });
  const stored = (store: ReturnType<typeof harness>["store"]) => store.list(KIND.closure, closureNoteSchema);

  it("saves an agent draft on the matching thread, and the thread becomes closed", async () => {
    const { ctx, store, seed, api } = harness();
    await seed(data);
    expect(await saveClosureDrafts(weekArg([draftFor({ impact: "p95 halved" })]), ctx)).toBe(1);
    const rows = await stored(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("th:jira:A-1");
    expect(rows[0]!.value).toMatchObject({ threadId: "th:jira:A-1", source: "agent", outcome: "better", impact: "p95 halved", at: NOW });
    const list = await api["threads.list"]({ weeks: 36 });
    expect(list.closures[0]!.source).toBe("agent");
  });
  it("never overwrites a note the user wrote", async () => {
    const { ctx, store, seed } = harness();
    await seed(data);
    await store.set(KIND.closure, "th:jira:A-1", { ...closure("th:jira:A-1"), result: "my words" });
    expect(await saveClosureDrafts(weekArg([draftFor()]), ctx)).toBe(0);
    const rows = await stored(store);
    expect(rows[0]!.value).toMatchObject({ result: "my words", source: "user" });
  });
  it("refreshes its own earlier draft, and a user edit then protects it", async () => {
    const { ctx, store, seed, api } = harness();
    await seed(data);
    await saveClosureDrafts(weekArg([draftFor()]), ctx);
    expect(await saveClosureDrafts(weekArg([draftFor({ result: "Better result" })]), ctx)).toBe(1);
    expect((await stored(store))[0]!.value).toMatchObject({ result: "Better result", source: "agent" });
    await api["closure.set"]({ threadId: "th:jira:A-1", outcome: "mixed", expectation: "e", result: "mine", learnings: "l" });
    expect((await stored(store))[0]!.value).toMatchObject({ result: "mine", source: "user" });
    expect(await saveClosureDrafts(weekArg([draftFor()]), ctx)).toBe(0);
    expect((await stored(store))[0]!.value.result).toBe("mine");
  });
  it("skips a draft whose claim has no thread, a hidden thread and a dropped thread, and does nothing without drafts", async () => {
    const { ctx, store, seed } = harness();
    await seed(data);
    expect(await saveClosureDrafts(weekArg([draftFor({ claimText: "Unrelated claim" })]), ctx)).toBe(0);
    expect(await saveClosureDrafts({ week: "2026-W45", shipped: [], ext: {} }, ctx)).toBe(0);
    await store.set(KIND.threadEdit, "th:jira:A-1", edit("th:jira:A-1", { hidden: true }));
    expect(await saveClosureDrafts(weekArg([draftFor()]), ctx)).toBe(0);
    await store.set(KIND.threadEdit, "th:jira:A-1", edit("th:jira:A-1", { drop: { reason: "cancelled" } }));
    expect(await saveClosureDrafts(weekArg([draftFor()]), ctx)).toBe(0);
    expect(await stored(store)).toEqual([]);
  });
  it("the week hook saves drafts from week.ext.closures", async () => {
    const { ctx, store, seed, reg } = harness();
    await seed(data);
    await reg.weekHooks[0]!.afterWeekSaved(weekArg([draftFor()]) as never, ctx);
    expect((await stored(store))[0]!.value.source).toBe("agent");
  });
});
