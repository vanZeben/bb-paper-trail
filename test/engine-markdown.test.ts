import { describe, expect, it } from "vitest";
import { extractMyNotes, MY_NOTES_HEADING, MY_NOTES_PLACEHOLDER, weekMarkdown } from "../lib/engine/markdown";
import type { CoverageMap, RoleFramework, WorkWeek } from "../lib/types";

const TZ = "America/New_York";
const ok = { status: "ok" as const, note: null };
const coverage: CoverageMap = {
  calendar: ok,
  granola: { status: "partial", note: "one | note unreadable" },
  fellow: { status: "off", note: "not connected" },
  jira: ok,
  github: ok,
  slack: { status: "failed", note: "no slack tool" },
};

const framework: RoleFramework = {
  version: 1,
  id: "senior_eng",
  name: "Senior engineer",
  subject: { name: "Alex", pronoun: "they" },
  managerName: "Sam",
  areas: [
    { key: "delivery", label: "Delivery", description: "Ships work", kind: "hands_on" },
    { key: "mentoring", label: "Mentoring & growth", description: "Helps others", kind: "leverage" },
  ],
  areaAliases: { coaching: "mentoring" },
  roleDoc: "",
  supplementDocs: [],
  rubric: { bar: "b", exceeds: "e", meets: "m", needsImprovement: "n", extraRules: [] },
  updatedAt: "2026-11-01T00:00:00Z",
};

const week: WorkWeek = {
  version: 2, week: "2026-W46", from: "2026-11-09", to: "2026-11-13", generatedAt: "2026-11-13T22:06:00.000Z", model: "opus", final: true,
  rating: "meets", ratingReason: "Solid | outcomes", threeLines: ["Line one", "Line two", "Line three"],
  days: ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"].map((date) => ({ date, rating: "meets" as const, reason: "ok\nmultiline", summary: "s", evidenceIds: ["C1109-1"] })),
  daysWorked: 5,
  scorecard: [
    { area: "delivery", status: "hit", note: "n", evidenceIds: ["C1109-1"] },
    { area: "coaching", status: "partial", note: "n", evidenceIds: [] },
    { area: "legacy_area", status: "missed", note: "n", evidenceIds: [] },
    { area: "retired", status: "hit", note: "n", evidenceIds: [] },
  ],
  shipped: [{ text: "Gateway TDD", evidenceIds: ["H1109-1"] }], inProgress: [], decisions: [], helping: [],
  meetings: { count: 21, hours: 17.5, pctOfWeek: 44, passiveCount: 3, topSinks: [{ title: "Design review", hours: 4 }] },
  recognition: [], openAsks: [], friction: [], raiseWithManager: [{ text: "Scope creep", evidenceIds: [] }],
  reflection: { goodWeek: true, text: "A good week." }, coverage,
  evidence: [{ id: "C1109-1", date: "2026-11-09", source: "calendar", kind: "meeting", what: "A | B", link: null, outcome: null, area: null }],
  frameworkId: "senior_eng",
  areasSnapshot: [{ key: "legacy_area", label: "Legacy area" }],
  plan: [],
  ext: {},
};

describe("extractMyNotes", () => {
  it("returns empty for missing, null or placeholder", () => {
    expect(extractMyNotes(null)).toBe("");
    expect(extractMyNotes("# x\n## Other\nstuff")).toBe("");
    expect(extractMyNotes(`${MY_NOTES_HEADING}\n${MY_NOTES_PLACEHOLDER}\n`)).toBe("");
  });
  it("keeps ### headings and stops at the next ##/# heading", () => {
    const raw = "## 9. Reflection\nx\n\n## My notes\nfirst\n### Sub\nsecond\n\n# Part 2: Evidence record\n| a |";
    expect(extractMyNotes(raw)).toBe("first\n### Sub\nsecond");
    expect(extractMyNotes("## My notes\nlast section, no more headings")).toBe("last section, no more headings");
  });
  it("accepts the numbered variant", () => {
    expect(extractMyNotes("## 10. My notes\nhello\n# Part 2: Evidence record\nno")).toBe("hello");
  });
  it("keeps the user's own ## headings and ends only at Part 2 or EOF", () => {
    expect(extractMyNotes("## My notes\nhello\n## Follow-ups\nmore\n\n# Part 2: Evidence record\n| x |")).toBe("hello\n## Follow-ups\nmore");
    expect(extractMyNotes("## My notes\nhello\n## Tail")).toBe("hello\n## Tail");
  });
});

describe("weekMarkdown", () => {
  const md = weekMarkdown(week, "", { framework, timeZone: TZ });
  it("renders the header line with numbers, zone and coverage marks", () => {
    expect(md).toContain("# Weekly work log 2026-W46 (Nov 9 - Nov 13)");
    expect(md).toContain("Generated 2026-11-13 17:06 America/New_York · Days worked 5 · Meetings 21 / 17.5 h (44%) · Coverage: calendar ✓ granola ⚠ jira ✓ confluence ✗ github ✓ slack ✗ vault ✗ memory ✗; not connected (no data expected): fellow");
    expect(md).toContain("> granola (partial): one \\| note unreadable");
    expect(md).toContain("> An empty source is not proof of no work.");
    expect(md).toContain("final: true");
  });
  it("has no source line in the front matter and no personal names", () => {
    expect(md.split("\n---\n")[0]).not.toContain("source:");
    expect(md.startsWith("---\nweek: 2026-W46\n")).toBe(true);
  });
  it("does not write a coverage note for off sources", () => {
    expect(md).not.toContain("fellow (off)");
  });
  it("renders sections, ids in code, empty lists, and escapes pipes and newlines", () => {
    expect(md).toContain("**Week rating: meets** - Solid \\| outcomes");
    expect(md).toContain("- Gateway TDD (`H1109-1`)");
    expect(md).toContain("### In progress\n- none recorded");
    expect(md).toContain("| Mon 11-09 | meets | ok multiline | `C1109-1` |");
    expect(md).toContain("21 meetings, 17.5 h, 44% of the week");
    expect(md).toContain("| `C1109-1` | 2026-11-09 | calendar | meeting | A \\| B |  |  |");
    expect(md).toContain("## My notes\n" + MY_NOTES_PLACEHOLDER);
    expect(md).toContain("Good week: yes. A good week.");
  });
  it("labels areas from the framework, then aliases, then the week snapshot, then the raw key", () => {
    expect(md).toContain("| Delivery | hit |");
    expect(md).toContain("| Mentoring & growth | partial |");
    expect(md).toContain("| Legacy area | missed |");
    expect(md).toContain("| retired | hit |");
  });
  it("names the manager and the subject from the framework", () => {
    expect(md).toContain("## 8. Worth raising with Sam\n- Scope creep");
    expect(md).toContain("## 7. Open asks on Alex");
  });
  it("falls back to 'my manager' when no manager is set", () => {
    const out = weekMarkdown(week, "", { framework: { ...framework, managerName: null }, timeZone: TZ });
    expect(out).toContain("## 8. Worth raising with my manager");
  });
  it("uses the zone for the generated time", () => {
    expect(weekMarkdown(week, "", { framework, timeZone: "UTC" })).toContain("Generated 2026-11-13 22:06 UTC");
  });
  it("round-trips the user's notes unchanged", () => {
    const notes = "Raise the staffing thing.\n### Follow-up\n- call Sam";
    const first = weekMarkdown(week, notes, { framework, timeZone: TZ });
    const extracted = extractMyNotes(first);
    expect(extracted).toBe(notes);
    expect(weekMarkdown(week, extracted, { framework, timeZone: TZ })).toBe(first);
  });
});
