/**
 * rubric.ts — builds the rating rules shared by the day and week prompts from a role framework, and resolves area
 * keys (current keys plus aliases for renamed areas).
 */
import { clip, type RoleFramework } from "../types";

const PRONOUNS = {
  they: { subj: "they", obj: "them", poss: "their" },
  he: { subj: "he", obj: "him", poss: "his" },
  she: { subj: "she", obj: "her", poss: "her" },
} as const;
export const pronounsOf = (framework: RoleFramework) => PRONOUNS[framework.subject.pronoun];
const capitalise = (s: string): string => (s === "" ? s : s[0]!.toUpperCase() + s.slice(1));
/** "Alex's", "the user's" */
export const possessiveOf = (framework: RoleFramework): string => `${framework.subject.name}'s`;

export const areaKeys = (framework: RoleFramework): string[] => framework.areas.map((a) => a.key);

/** The current key for `key` (a current key, or an alias of a renamed one); null when unknown. */
export function resolveArea(framework: RoleFramework, key: string): string | null {
  if (framework.areas.some((a) => a.key === key)) return key;
  const aliased = Object.hasOwn(framework.areaAliases, key) ? framework.areaAliases[key] : undefined;
  return aliased !== undefined && framework.areas.some((a) => a.key === aliased) ? aliased : null;
}

function noteSourceRule(sources: readonly string[]): string {
  if (sources.length === 0) return "";
  if (sources.length === 1)
    return `- ${sources[0]} is the meeting-note source: if it is ok for a day, that day's meetings are covered; if it failed, say so rather than assuming the meetings were empty.\n`;
  return `- ${sources.join(" and ")} are all meeting-note sources (one may cover dates another cannot read): if any one is ok for a day, its meetings are covered, so a failed one alone is not missing data.\n`;
}

/**
 * Rating rules shared by both prompts. `roleDocMax` clips the role document (default 6000); `supplementMax` clips each
 * supplement document (default 5000, the day prompt passes less).
 */
export function ratingRules(framework: RoleFramework, opts: { enabledNoteSources: string[]; roleDocMax?: number; supplementMax?: number }): string {
  const p = pronounsOf(framework);
  const leverage = framework.areas.filter((a) => a.kind === "leverage").map((a) => a.label);
  const leverageText = leverage.length > 0 ? `the leverage areas (${leverage.join(", ")})` : "the role areas";
  const r = framework.rubric;
  const roleDoc = framework.roleDoc.trim() === "" ? "(no role document provided: use the areas below as the standard)" : clip(framework.roleDoc, opts.roleDocMax ?? 6000);
  const supplements = framework.supplementDocs
    .filter((d) => d.text.trim() !== "")
    .map((d) => `## ${d.title}\n${clip(d.text, opts.supplementMax ?? 5000)}\n`)
    .join("");
  const areas = framework.areas.map((a) => `- ${a.key} (${a.label}): ${a.description}`).join("\n");
  const extra = r.extraRules.map((rule) => `- ${rule}`).join("\n");
  return `## ${capitalise(possessiveOf(framework))} role (the standard)
${roleDoc}
${supplements}## Role areas (use these keys)
${areas}
## How to rate (follow exactly)
- Rate OUTCOMES against the role: decisions made, reviews done, people unblocked, direction set, things shipped.
- A review, design or decision meeting that moved something counts the same as deep work.
- Meeting load only pulls a day down when it crowded out ${p.poss} own commitments or produced no visible outcome. Never lower a rating for meeting hours alone.
- ${r.bar}
- exceeds: ${r.exceeds} Leverage is judged on ${leverageText}.
- meets: ${r.meets}
- needs_improvement: ${r.needsImprovement}
- none: out of office, holiday, sick, or too little could be READ to judge. Only use none for a thin day when there is a sign ${p.subj} ${p.subj === "they" ? "were" : "was"} away (an OOO or holiday event, every meeting declined plus near-silence everywhere, or someone saying so); then say "likely away" in the reason.
- Coverage: a source marked partial or failed is MISSING DATA, not proof of no work. Do not mark a day down for what a failed source might hold; name the gap in the reason, and use none when almost nothing could be read. A source marked off is not connected or turned off: ignore it, it is never missing data and never a reason for a lower rating. But when the main sources (calendar, meeting notes, chat, code host, tracker/wiki) read ok and show little, that IS evidence of a light day: rate it as one.
${noteSourceRule(opts.enabledNoteSources)}- Notes-vault and agent-memory entries are ${possessiveOf(framework)} own notes and records; they often restate an item another source already shows. Count one outcome once (cite both ids if useful), and treat them as supporting detail, not extra work.
- Every rating cites evidence ids exactly as listed. Never cite an id that is not in the list. Use names as written in the evidence; never invent one.
- Sensitive: keep others' compensation, health or HR matters vague; skip anything marked off the record.${extra === "" ? "" : `\n${extra}`}`;
}
