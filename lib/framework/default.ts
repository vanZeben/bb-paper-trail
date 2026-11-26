/**
 * default.ts — the neutral built-in role framework: six generic engineering areas and a rubric with no person,
 * employer or team in it. Users replace it from their own role document (framework feature) or edit it in place.
 */
import type { RoleFramework } from "../types";

export const DEFAULT_FRAMEWORK: RoleFramework = {
  version: 1,
  id: "default",
  name: "General engineering",
  subject: { name: "the user", pronoun: "they" },
  managerName: null,
  areas: [
    { key: "delivery", label: "Delivery", description: "Shipping working changes and finishing planned work: PRs merged, tickets resolved, docs written.", kind: "hands_on" },
    { key: "technical_design", label: "Technical design", description: "Designs, ADRs and technical decisions made, reviewed or ratified; direction on how things should be built.", kind: "leverage" },
    { key: "quality_reliability", label: "Quality and reliability", description: "Reviews, tests, incident follow-up and operational health; reducing future toil and risk.", kind: "other" },
    { key: "collaboration", label: "Collaboration", description: "Unblocking others, cross-team coordination, clear communication and responsive reviews.", kind: "leverage" },
    { key: "mentorship", label: "Mentorship", description: "Coaching, feedback, onboarding and growing other engineers.", kind: "leverage" },
    { key: "direction", label: "Direction", description: "Setting priorities and scope, aligning teams on goals, shaping roadmap and standards.", kind: "leverage" },
  ],
  areaAliases: {},
  roleDoc: "",
  supplementDocs: [],
  rubric: {
    bar: 'The bar is a solid, normal working day for an engineer at this level, not "did anything at all".',
    exceeds:
      "At least two distinct outcomes with leverage beyond individual output that others adopt or act on, such as a decision made or ratified, a design or ADR approved, direction set for another team, someone coached through a real call, or a cross-team unblock. One leverage outcome on its own is meets, not exceeds. Merely attending or touching an area is not exceeds.",
    meets:
      "A full day of solid role-relevant output: at least two distinct substantive outcomes (a decision driven, a doc written, a PR opened or merged, a substantive review, a scoping call), or one substantive outcome plus several smaller ones that together add up to a full day. Two items about the same piece of work (e.g. opening and merging one PR) count as one.",
    needsImprovement:
      'A working day with little visible output: one small conversation or a single light review, only one substantive outcome and little else (say "one outcome" in the reason), activity with no outcome, or planned commitments that slipped. Use it for thin days even when nothing went wrong; the reason says "light day" plainly and lists what was seen.',
    extraRules: [
      "Leverage beyond individual output is what separates exceeds from meets: count outcomes others adopt or act on, not the volume of solo output.",
      "Rate outcomes, never attendance: time in meetings or hours online is not output.",
      "Missing data is never evidence of no work: a source marked partial or failed is a gap to name, not a reason to rate a day down.",
    ],
  },
  updatedAt: "1970-01-01T00:00:00.000Z",
};

export const PRESET_FRAMEWORKS: RoleFramework[] = [DEFAULT_FRAMEWORK];
