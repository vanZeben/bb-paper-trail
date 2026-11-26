import { describe, expect, it } from "vitest";
import { connectorCheckJob, connectorCheckPrompt, CONNECTOR_STALE_MS, isConnectorCheckStale, validateConnectorReply } from "../lib/capture/connector-check";
import { createRegistry, type FeatureCtx } from "../lib/engine/extensions";
import type { Job, Runner } from "../lib/engine/runner";
import { createWorklogService } from "../lib/engine/service";
import { AUTO_CHECK_META, pickHost, readCheck, recheckIfStale, runConnectorCheck } from "../lib/features/connectors/check";
import { DEFAULT_FRAMEWORK } from "../lib/framework/default";
import { DEFAULT_SETTINGS, type Settings } from "../lib/settings";
import { createMemoryStore } from "../lib/storage/memory";
import { KIND } from "../lib/storage/port";
import { SOURCE_IDS, workDaySchema, type ConnectorCheck } from "../lib/types";
import { gapSummary } from "../components/settings/gaps";

const reply = (sources: Record<string, unknown>) => ({ sources });
const good = { available: true, via: "jira-mcp", account: "Alex Doe", note: null };

describe("validateConnectorReply", () => {
  it("accepts a good reply and fills missing ids as unknown", () => {
    const out = validateConnectorReply(reply({ jira: good, github: { ...good, via: "gh", account: "@alex", mode: "gh" } }));
    expect(out.jira).toEqual({ available: true, via: "jira-mcp", account: "Alex Doe", note: null, mode: null });
    expect(out.github?.mode).toBe("gh");
    expect(out.slack).toEqual({ available: null, via: null, account: null, note: null, mode: null });
    expect(Object.keys(out).sort()).toEqual([...SOURCE_IDS].sort());
  });

  it("throws when available is not a boolean", () => {
    for (const bad of ["yes", 1, null, undefined]) expect(() => validateConnectorReply(reply({ jira: { ...good, available: bad } }))).toThrow(/available must be a boolean/);
  });

  it("drops unknown ids and ids that were not asked for", () => {
    const out = validateConnectorReply(reply({ jira: good, nonsense: good, slack: good }), ["jira", "github"]);
    expect(Object.keys(out).sort()).toEqual(["github", "jira"]);
    expect(out.github?.available).toBeNull();
  });

  it("only keeps `mode` for github and rejects a malformed envelope", () => {
    expect(validateConnectorReply(reply({ jira: { ...good, mode: "mcp" } })).jira?.mode).toBeNull();
    expect(validateConnectorReply(reply({ github: { ...good, mode: "mcp" } })).github?.mode).toBe("mcp");
    expect(() => validateConnectorReply({})).toThrow();
    expect(() => validateConnectorReply(reply({ jira: "ok" }))).toThrow(/not an object/);
  });

  it("builds a prompt with one probe per asked source, and a job that validates", () => {
    const prompt = connectorCheckPrompt(["jira", "github"]);
    expect(prompt).toContain("- jira (Jira)");
    expect(prompt).not.toContain("- slack");
    expect(prompt).toContain('"mode":"gh"');
    const job = connectorCheckJob(["jira"]);
    expect(job.validate(reply({ jira: good }))).toHaveProperty("jira");
    expect(() => connectorCheckJob([])).toThrow();
  });
});

describe("staleness", () => {
  const check = (checkedAt: string) => ({ checkedAt });
  const now = new Date("2026-11-20T12:00:00Z");
  it("is stale without a check, after 7 days or when unparseable", () => {
    expect(isConnectorCheckStale(null, now)).toBe(true);
    expect(isConnectorCheckStale(check(new Date(now.getTime() - CONNECTOR_STALE_MS - 1000).toISOString()), now)).toBe(true);
    expect(isConnectorCheckStale(check(new Date(now.getTime() - CONNECTOR_STALE_MS + 1000).toISOString()), now)).toBe(false);
    expect(isConnectorCheckStale(check("garbage"), now)).toBe(true);
  });
});

function ctxFor(overrides: Partial<Settings> = {}, replyFor: (job: Job) => unknown = (job) => job.validate(reply({ jira: good, github: { ...good, mode: "gh" } }))) {
  const store = createMemoryStore();
  const jobs: string[] = [];
  let at = new Date("2026-11-20T12:00:00Z");
  const settings: Settings = { ...DEFAULT_SETTINGS, enabledSources: ["jira", "github"], captureModel: "small", ...overrides };
  const runner: Runner = {
    status: () => ({ running: 0, queued: 0 }),
    runJob: (async (job: Job) => {
      jobs.push(job.kind);
      return replyFor(job);
    }) as Runner["runJob"],
  };
  const published: number[] = [];
  const ctx: FeatureCtx = { store, settings: () => settings, framework: async () => DEFAULT_FRAMEWORK, runner, log: { info: () => undefined, warn: () => undefined }, publish: () => void published.push(1), now: () => at };
  return { ctx, store, jobs, published, advance: (ms: number) => void (at = new Date(at.getTime() + ms)), settings };
}
const hosts = async () => [
  { id: "h1", name: "Laptop", connected: false },
  { id: "h2", name: "Desk", connected: true },
];

describe("runConnectorCheck", () => {
  it("runs one job for the enabled sources and stores the latest check with host and model", async () => {
    const h = ctxFor();
    const check = await runConnectorCheck(h.ctx, hosts);
    expect(h.jobs).toEqual(["connector-check"]);
    expect(check?.hostId).toBe("h2");
    expect(check?.model).toBe("small");
    const stored = await readCheck(h.ctx);
    expect(stored?.sources.jira?.available).toBe(true);
    expect(Object.keys(stored!.sources).sort()).toEqual(["github", "jira"]);
    expect(h.published.length).toBe(1);
  });

  it("is single-flight and refuses to run with no sources", async () => {
    const h = ctxFor();
    const [a, b] = [runConnectorCheck(h.ctx, hosts), runConnectorCheck(h.ctx, hosts)];
    expect(await b).toBeNull();
    expect(await a).not.toBeNull();
    expect(h.jobs.length).toBe(1);
    const empty = ctxFor({ enabledSources: [] });
    await expect(runConnectorCheck(empty.ctx, hosts)).rejects.toThrow(/no sources/);
  });

  it("picks the named capture host, else the first connected one", () => {
    expect(pickHost([{ id: "h1", name: "Laptop", connected: false }, { id: "h2", name: "Desk", connected: true }], "laptop")).toEqual({ id: "h1", name: "Laptop" });
    expect(pickHost([{ id: "h1", name: "Laptop", connected: false }], "")).toEqual({ id: "", name: "unknown" });
  });
});

describe("recheckIfStale", () => {
  it("re-runs a missing or stale check at most once a week", async () => {
    const h = ctxFor();
    expect(await recheckIfStale(h.ctx, hosts)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.jobs.length).toBe(1);
    // fresh now: nothing
    expect(await recheckIfStale(h.ctx, hosts)).toBe(false);
    // 8 days later the check is stale again and the last attempt is over a week old
    h.advance(8 * 24 * 3600 * 1000);
    expect(await recheckIfStale(h.ctx, hosts)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.jobs.length).toBe(2);
  });

  it("does not retry a failing check within a week of the last attempt", async () => {
    const h = ctxFor({}, () => {
      throw new Error("boom");
    });
    expect(await recheckIfStale(h.ctx, hosts)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(await h.store.getMeta(AUTO_CHECK_META)).not.toBeNull();
    h.advance(3 * 24 * 3600 * 1000);
    expect(await recheckIfStale(h.ctx, hosts)).toBe(false);
  });
});

describe("an unavailable source", () => {
  it("produces no capture job and its coverage is off", async () => {
    const h = ctxFor({ enabled: true, timeZone: "America/New_York", enabledSources: [...SOURCE_IDS] });
    const stored: ConnectorCheck = {
      checkedAt: "2026-11-19T00:00:00Z",
      hostId: "h",
      hostName: "Desk",
      model: null,
      sources: { jira: { available: false, via: null, account: null, note: "not signed in", mode: null } },
    };
    await h.store.set(KIND.connectors, "latest", stored);
    // every job fails: captureDays never throws, a failing source just becomes failed coverage
    const runner: Runner = {
      status: () => ({ running: 0, queued: 0 }),
      runJob: (async (job: Job) => {
        h.jobs.push(job.kind);
        throw new Error("no tools");
      }) as Runner["runJob"],
    };
    const ctx: FeatureCtx = { ...h.ctx, runner };
    const service = createWorklogService({
      store: h.store,
      runner,
      registry: createRegistry(),
      ctx,
      settings: h.ctx.settings,
      framework: async () => DEFAULT_FRAMEWORK,
      connectors: () => readCheck(h.ctx),
      onboarded: async () => true,
      notify: () => undefined,
      now: () => new Date("2026-11-19T22:00:00Z"),
    });
    await service.runDayNow("2026-11-19");
    expect(h.jobs.some((k) => k.includes("jira"))).toBe(false);
    expect(h.jobs.length).toBeGreaterThan(0);
    const day = await h.store.get(KIND.day, "2026-11-19", workDaySchema);
    expect(day?.coverage.jira?.status).toBe("off");
    expect(day?.coverage.jira?.note).toBe("not signed in");
    expect(day?.coverage.slack?.status).toBe("failed");
  });
});

describe("gapSummary", () => {
  const cell = (date: string, coverage: Record<string, "ok" | "off" | "failed">) => ({ date, state: "rated" as const, coverage });
  const week = (cells: ReturnType<typeof cell>[]) => ({ cells });
  const check = { sources: { jira: { available: true }, slack: { available: false } } };

  it("counts not-captured (failed) days of an available source as fillable, but not ok days or unavailable sources", () => {
    const grid = { weeks: [week([cell("a", { jira: "failed" }), cell("b", { jira: "ok" }), cell("c", { slack: "failed" })])] };
    expect(gapSummary(grid, check)).toEqual({ days: 1, weeks: 1 });
  });

  it("counts days with an off source that is now available, and the weeks they span", () => {
    const grid = { weeks: [week([cell("a", { jira: "off" }), cell("b", { jira: "ok" })]), week([cell("c", { slack: "off" })]), week([cell("d", { jira: "off" }), cell("e", { jira: "off" })])] };
    expect(gapSummary(grid, check)).toEqual({ days: 3, weeks: 3 });
    expect(gapSummary({ weeks: grid.weeks.slice(1, 2) }, check)).toEqual({ days: 0, weeks: 0 });
    expect(gapSummary(grid, null)).toEqual({ days: 0, weeks: 0 });
  });
});

describe("estimateRuns", () => {
  it("counts runs per week from the connected sources", async () => {
    const { estimateRuns } = await import("../components/onboarding/cost");
    expect(estimateRuns(null, 4)).toEqual({ perWeek: 20, total: 80 });
    const check = { checkedAt: "", hostId: "", hostName: "", model: null, sources: { slack: { available: false }, jira: { available: false }, confluence: { available: false }, granola: { available: false }, fellow: { available: false }, vault: { available: false }, memory: { available: false } } } as unknown as ConnectorCheck;
    // calendar + github left: per day meetings + rating = 2, one range run, one judgment
    expect(estimateRuns(check, 2)).toEqual({ perWeek: 5 * 2 + 1 + 1, total: 24 });
  });
});
