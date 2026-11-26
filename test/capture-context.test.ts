import { describe, expect, it } from "vitest";
import { validateContextReply, worklogContextJob, type ContextOptions } from "../lib/capture/context";

const range = { from: "2026-08-17", to: "2026-08-18" };
const TZ = "America/New_York";
const BOTH: ContextOptions = { timeZone: TZ, skipFolders: ["projects/generated"], includeVault: true, includeMemory: true };

describe("worklog context (vault + memory)", () => {
  it("drops out-of-range memory rows, maps kinds, skips excluded folders and merges duplicates", () => {
    const out = validateContextReply(
      {
        vault: {
          available: true,
          note: null,
          entries: [
            { date: "2026-08-17", kind: "log_entry", path: "projects/gateway/Log.md", what: "Chose token forwarding" },
            { date: "2026-08-17", kind: "note_written", path: "projects/generated/Weekly/2026-W34.md", what: "generated" },
            { date: "2026-08-17", kind: "note_written", path: "projects/generated-notes/Idea.md", what: "sibling folder with a shared prefix is kept" },
          ],
        },
        memory: {
          available: true,
          note: "digest for 08-18 missing",
          entries: [
            { date: "2026-08-17", kind: "completion", project: "billing", what: "Shipped the invoice fix" },
            { date: "2026-08-17", kind: "completion", project: "billing", what: "Shipped the invoice fix" },
            { date: "2026-04-18", kind: "summary", project: "billing", what: "old digest" },
          ],
        },
      },
      range,
      BOTH,
    );
    expect(out.vault["2026-08-17"]!.entries.map((e) => e.what)).toEqual(["projects/gateway/Log: Chose token forwarding", "projects/generated-notes/Idea: sibling folder with a shared prefix is kept"]);
    expect(out.memory["2026-08-17"]!.entries).toEqual([{ date: "2026-08-17", source: "memory", kind: "outcome", what: "[billing]: Shipped the invoice fix", link: null, outcome: null }]);
    expect(out.memory["2026-08-18"]!.coverage).toEqual({ status: "partial", note: "digest for 08-18 missing" });
    expect(out.vault["2026-08-18"]!.coverage.status).toBe("ok");
  });

  it("fails one side without failing the other, and the prompt lists every date and the skipped folders", () => {
    const out = validateContextReply({ vault: { available: false, note: "no vault tool" }, memory: { available: true, entries: [] } }, range, BOTH);
    expect(out.vault["2026-08-17"]!.coverage).toEqual({ status: "failed", note: "no vault tool" });
    expect(out.memory["2026-08-17"]!.coverage.status).toBe("ok");
    const job = worklogContextJob(range, BOTH);
    expect(job.prompt).toContain("2026-08-17, 2026-08-18");
    expect(job.prompt).toContain("projects/generated");
    expect(job.prompt).toContain(TZ);
    expect(job.prompt).toMatch(/Never write/);
  });

  it("uses a generic prompt with no work-specific names", () => {
    const { prompt } = worklogContextJob(range, BOTH);
    expect(prompt).toMatch(/the user's notes vault tools/);
    expect(prompt).toMatch(/the agent memory tools/);
    expect(prompt).not.toMatch(/search_work_memory|WORK DIGEST|work vault|5-Projects/i);
  });

  it("omits the skip-folders sentence when there are none", () => {
    const { prompt } = worklogContextJob(range, { ...BOTH, skipFolders: [] });
    expect(prompt).not.toMatch(/Skip these folders/);
  });
});

describe("excluded parts", () => {
  it("includeMemory:false yields off memory coverage for each date and never asks about memory", () => {
    const opts = { ...BOTH, includeMemory: false };
    const job = worklogContextJob(range, opts);
    expect(job.prompt).not.toMatch(/memory/i);
    expect(job.prompt).not.toContain('"memory"');
    // A stray memory section in the reply is ignored, and a missing one is fine.
    const out = job.validate({ vault: { available: true, note: null, entries: [{ date: "2026-08-17", kind: "log_entry", path: "a/Log.md", what: "w" }] }, memory: { available: true, entries: [{ date: "2026-08-17", kind: "decision", what: "x" }] } });
    for (const d of ["2026-08-17", "2026-08-18"]) {
      expect(out.memory[d]).toEqual({ coverage: { status: "off", note: "not connected" }, entries: [] });
    }
    expect(out.vault["2026-08-17"]!.entries).toHaveLength(1);
    expect(job.validate({ vault: { available: true, note: null, entries: [] } }).memory["2026-08-18"]!.coverage.status).toBe("off");
  });

  it("includeVault:false yields off vault coverage and leaves vault out of the prompt", () => {
    const job = worklogContextJob(range, { ...BOTH, includeVault: false });
    expect(job.prompt).not.toMatch(/vault/i);
    const out = job.validate({ memory: { available: true, note: null, entries: [{ date: "2026-08-18", kind: "decision", project: "billing", what: "Pick plan B" }] } });
    expect(out.vault["2026-08-17"]!.coverage.status).toBe("off");
    expect(out.vault["2026-08-18"]!.coverage.status).toBe("off");
    expect(out.memory["2026-08-18"]!.entries.map((e) => e.kind)).toEqual(["decision"]);
  });

  it("both excluded: nothing to fetch, everything off, any reply accepted", () => {
    const job = worklogContextJob(range, { ...BOTH, includeVault: false, includeMemory: false });
    expect(job.prompt).toMatch(/Nothing to fetch/);
    const out = job.validate({});
    expect(Object.values({ ...out.vault, ...out.memory }).every((p) => p.coverage.status === "off")).toBe(true);
  });
});

describe("settings sanitising", () => {
  it("drops skip folders with control characters or quotes and quotes the rest", () => {
    const { prompt } = worklogContextJob(range, { ...BOTH, skipFolders: ["ok/folder", 'bad"quote', "new\nline", "back`tick", "it's"] });
    expect(prompt).toContain('Skip these folders entirely: "ok/folder".');
    for (const bad of ["bad", "new", "back", "it's"]) expect(prompt).not.toContain(`"${bad}`);
  });
});

describe("context identity", () => {
  const identity = { name: "Alex Doe", email: "alex@example.com", handles: { slack: "U0ALEX", github: "alexdoe" } };
  it("adds the identity line", () => {
    expect(worklogContextJob(range, { ...BOTH, identity }).prompt).toContain("The user is Alex Doe (alex@example.com; Slack U0ALEX; GitHub @alexdoe). In meeting transcripts and notes, their lines are attributed to this name or email.");
    expect(worklogContextJob(range, BOTH).prompt).not.toContain("The user is");
  });
});
