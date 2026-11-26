import { describe, expect, it } from "vitest";
import { weekJudgeJob, validateWeekJudgment } from "../lib/engine/rating";
import { DEFAULT_FRAMEWORK, PRESET_FRAMEWORKS } from "../lib/framework/default";
import { areaKeys, ratingRules, resolveArea } from "../lib/framework/rubric";
import { roleFrameworkSchema, type RoleFramework } from "../lib/types";

const custom: RoleFramework = {
  ...DEFAULT_FRAMEWORK,
  id: "custom",
  name: "Custom",
  subject: { name: "Alex", pronoun: "she" },
  managerName: "Sam",
  areas: [
    { key: "build", label: "Build", description: "Ships things.", kind: "hands_on" },
    { key: "guide", label: "Guide", description: "Guides people.", kind: "leverage" },
    { key: "plan_ahead", label: "Plan ahead", description: "Sets direction.", kind: "leverage" },
  ],
  areaAliases: { planning: "plan_ahead" },
};

describe("default framework", () => {
  it("validates and has the six generic areas", () => {
    expect(roleFrameworkSchema.parse(DEFAULT_FRAMEWORK)).toEqual(DEFAULT_FRAMEWORK);
    expect(areaKeys(DEFAULT_FRAMEWORK)).toEqual(["delivery", "technical_design", "quality_reliability", "collaboration", "mentorship", "direction"]);
    expect(DEFAULT_FRAMEWORK.subject).toEqual({ name: "the user", pronoun: "they" });
    expect(DEFAULT_FRAMEWORK.managerName).toBeNull();
    expect(PRESET_FRAMEWORKS).toEqual([DEFAULT_FRAMEWORK]);
  });
  it("builds rules with every area label", () => {
    const text = ratingRules(DEFAULT_FRAMEWORK, { enabledNoteSources: ["granola", "fellow"] });
    for (const a of DEFAULT_FRAMEWORK.areas) {
      expect(text).toContain(a.label);
      expect(text).toContain(a.key);
    }
    expect(text).toContain("The user's role");
  });
});

describe("rubric rules", () => {
  it("uses the subject's name and pronoun", () => {
    const text = ratingRules(custom, { enabledNoteSources: [] });
    expect(text).toContain("Alex's role");
    expect(text).toContain("her own commitments");
    expect(text).toContain("sign she was away");
  });
  it("generates the meeting-notes rule only from the enabled sources", () => {
    const both = ratingRules(custom, { enabledNoteSources: ["granola", "fellow"] });
    expect(both).toContain("granola and fellow are all meeting-note sources");
    expect(ratingRules(custom, { enabledNoteSources: ["fellow"] })).toContain("fellow is the meeting-note source");
    const none = ratingRules(custom, { enabledNoteSources: [] });
    expect(none).not.toMatch(/meeting-note source/);
    expect(none).not.toContain("granola");
  });
  it("treats off sources as never missing data", () => {
    expect(ratingRules(custom, { enabledNoteSources: [] })).toMatch(/marked off[^.]*never missing data/);
  });
  it("includes the extra rules and clips the role doc", () => {
    const f = { ...custom, roleDoc: "z".repeat(6000), rubric: { ...custom.rubric, extraRules: ["CUSTOM RULE ONE"] } };
    const text = ratingRules(f, { enabledNoteSources: [], roleDocMax: 500 });
    expect(text).toContain("CUSTOM RULE ONE");
    expect(text).not.toContain("z".repeat(501));
  });
});

describe("areas", () => {
  it("resolves current keys and aliases, and rejects unknown ones", () => {
    expect(resolveArea(custom, "guide")).toBe("guide");
    expect(resolveArea(custom, "planning")).toBe("plan_ahead");
    expect(resolveArea(custom, "nope")).toBeNull();
    expect(resolveArea(custom, "toString")).toBeNull();
    expect(resolveArea({ ...custom, areaAliases: { old: "gone" } }, "old")).toBeNull();
  });
});

describe("week judgment with a custom framework", () => {
  const ids = new Set(["C1109-1"]);
  const dates = ["2026-11-09"];
  const row = (area: string) => ({ area, status: "hit", note: "n", evidenceIds: ["C1109-1"] });
  const judgment = (scorecard: unknown[]) => ({
    week: "2026-W46", rating: "meets", ratingReason: "r", threeLines: ["a"],
    days: [{ date: "2026-11-09", rating: "meets", reason: "r", summary: "s", areas: ["planning", "build"], evidenceIds: ["C1109-1"] }],
    scorecard, reflection: { goodWeek: true, text: "t" }, plan: [{ itemId: "p1" }],
  });
  const args = { week: "2026-W46", dates, ids, framework: custom };

  it("rejects an unknown scorecard key and a missing area", () => {
    expect(() => validateWeekJudgment(judgment([row("build"), row("guide"), row("delivery")]), args)).toThrow(/invalid scorecard area/);
    expect(() => validateWeekJudgment(judgment([row("build"), row("guide")]), args)).toThrow(/missing areas: plan_ahead/);
  });
  it("accepts an alias in the scorecard and in day areas", () => {
    const out = validateWeekJudgment(judgment([row("build"), row("guide"), row("planning")]), args);
    expect(out.scorecard.map((s) => s.area)).toEqual(["build", "guide", "plan_ahead"]);
    expect(out.days[0]!.areas).toEqual(["build", "plan_ahead"]);
  });
  it("returns the raw reply for extension validation", () => {
    const out = validateWeekJudgment(judgment([row("build"), row("guide"), row("plan_ahead")]), args);
    expect(out.raw.plan).toEqual([{ itemId: "p1" }]);
  });
  it("splices extra rules and the extra reply example into the week prompt", () => {
    const job = weekJudgeJob({
      week: "2026-W46", dates, days: [], framework: custom, workdayHours: 8, timeZone: "America/New_York", previous: null, enabledNoteSources: [],
      extraRules: "EXTRA WEEK RULE", extraReplyExample: '"plan":[{"itemId":"abc","status":"done"}]',
    });
    expect(job.prompt).toContain("EXTRA WEEK RULE");
    expect(job.prompt).toContain('"reflection":{"goodWeek":true,"text":"..."},\n "plan":[{"itemId":"abc","status":"done"}]}');
    expect(job.prompt).toContain('one entry for each area: build, guide, plan_ahead');
    expect(job.prompt).toContain("worth raising with Sam");
    const plain = weekJudgeJob({ week: "2026-W46", dates, days: [], framework: custom, workdayHours: 8, timeZone: "America/New_York", previous: null, enabledNoteSources: [] });
    expect(plain.prompt).toContain('"reflection":{"goodWeek":true,"text":"..."}}');
  });
});
