/** markdown.ts — the weekly report as a markdown note, with the user's `## My notes` section carried over on re-runs. */
import type { AreaSnapshot, Claim, CoverageMap, RoleFramework, WorkWeek } from "../types";
import { SOURCE_IDS } from "../types";
import { coverageLine, withAllSources } from "./evidence";
import { localParts } from "./time";

export const MY_NOTES_HEADING = "## My notes";
export const MY_NOTES_PLACEHOLDER = "_Yours. This section is kept when the report is re-generated._";

const MY_NOTES_RE = /^##\s+(?:10\.\s*)?My notes\s*$/i;
// The section ends only at the evidence record the renderer emits (or EOF): the user may use their own `##` headings.
const NEXT_SECTION_RE = /^#\s+Part\s+2\b/i;

/** The text under `## My notes` (up to `# Part 2` or the end), trimmed; "" when missing or still the placeholder. */
export function extractMyNotes(existing: string | null): string {
  if (existing === null) return "";
  const lines = existing.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => MY_NOTES_RE.test(l));
  if (start < 0) return "";
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (NEXT_SECTION_RE.test(line)) break;
    body.push(line);
  }
  const text = body.join("\n").trim();
  return text === MY_NOTES_PLACEHOLDER ? "" : text;
}

const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
const ids = (list: readonly string[]): string => (list.length === 0 ? "" : list.map((i) => `\`${i}\``).join(" "));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (date: string): string => `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dow = (date: string): string => WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
const RATING_TEXT = { exceeds: "exceeds", meets: "meets", needs_improvement: "needs improvement", none: "none" } as const;

function claims(list: readonly Claim[]): string {
  if (list.length === 0) return "- none recorded";
  return list.map((c) => `- ${cell(c.text)}${c.evidenceIds.length > 0 ? ` (${ids(c.evidenceIds)})` : ""}`).join("\n");
}

/** Notes for sources that are partial or failed. Sources that are off (not connected) are not gaps and get no note. */
function coverageNotes(coverage: CoverageMap): string {
  const c = withAllSources(coverage);
  return SOURCE_IDS.filter((s) => c[s]!.status !== "ok" && c[s]!.status !== "off")
    .map((s) => `> ${s} (${c[s]!.status}): ${cell(c[s]!.note ?? "no detail")}`)
    .join("\n");
}

/** Label for an area key: the framework (following renames), then the week's own snapshot, then the raw key. */
function areaLabeler(framework: RoleFramework, snapshot: readonly AreaSnapshot[]): (key: string) => string {
  return (key) =>
    framework.areas.find((a) => a.key === key)?.label ??
    framework.areas.find((a) => a.key === framework.areaAliases[key])?.label ??
    snapshot.find((a) => a.key === key)?.label ??
    key;
}

export function weekMarkdown(week: WorkWeek, myNotes: string, opts: { framework: RoleFramework; timeZone: string }): string {
  const { framework, timeZone } = opts;
  const gen = localParts(new Date(week.generatedAt), timeZone);
  const m = week.meetings;
  const notes = coverageNotes(week.coverage);
  const label = areaLabeler(framework, week.areasSnapshot);
  const subject = framework.subject.name;
  const manager = framework.managerName ?? "my manager";
  const out: string[] = [];
  out.push(`---
week: ${week.week}
generated: ${week.generatedAt}
rating: ${week.rating}
final: ${week.final}
---
# Weekly work log ${week.week} (${shortDate(week.from)} - ${shortDate(week.to)})

Generated ${gen.date} ${gen.time} ${timeZone} · Days worked ${week.daysWorked} · Meetings ${m.count} / ${m.hours} h (${m.pctOfWeek}%) · Coverage: ${coverageLine(week.coverage)}
${notes === "" ? "" : `${notes}\n`}> An empty source is not proof of no work.${week.final ? "" : "\n> Not final: the week is not over yet."}`);

  out.push(`## 1. Week in three lines
${week.threeLines.filter((l) => l !== "").map((l) => `- ${cell(l)}`).join("\n")}

**Week rating: ${RATING_TEXT[week.rating]}** - ${cell(week.ratingReason)}

| Day | Rating | Why | Evidence |
|---|---|---|---|
${week.days.map((d) => `| ${dow(d.date)} ${d.date.slice(5)} | ${RATING_TEXT[d.rating]} | ${cell(d.reason)} | ${ids(d.evidenceIds)} |`).join("\n")}`);

  out.push(`## 2. Role-card scorecard
| Area | Status | Note | Evidence |
|---|---|---|---|
${week.scorecard.map((s) => `| ${cell(label(s.area))} | ${s.status} | ${cell(s.note)} | ${ids(s.evidenceIds)} |`).join("\n")}`);

  out.push(`## 3. Shipped / done
${claims(week.shipped)}

### In progress
${claims(week.inProgress)}`);

  out.push(`## 4. Decisions & influence
${claims(week.decisions)}

### Helping & developing others
${claims(week.helping)}`);

  out.push(`## 5. Meetings
${m.count} meetings, ${m.hours} h, ${m.pctOfWeek}% of the week (${week.daysWorked} days worked). Passive: ${m.passiveCount}. Top time sinks: ${m.topSinks.length === 0 ? "none" : m.topSinks.map((s) => `${cell(s.title)} (${s.hours} h)`).join(", ")}`);

  out.push(`## 6. Recognition
${claims(week.recognition)}`);

  out.push(`## 7. Open asks on ${cell(subject)}
${claims(week.openAsks)}

### Friction & things that slipped
${claims(week.friction)}`);

  out.push(`## 8. Worth raising with ${cell(manager)}
${claims(week.raiseWithManager)}`);

  out.push(`## 9. Reflection
Good week: ${week.reflection.goodWeek ? "yes" : "no"}. ${cell(week.reflection.text)}`);

  out.push(`${MY_NOTES_HEADING}
${myNotes.trim() === "" ? MY_NOTES_PLACEHOLDER : myNotes.trim()}`);

  out.push(`# Part 2: Evidence record
| ID | Date | Source | Kind | What | Outcome | Link |
|---|---|---|---|---|---|---|
${week.evidence.map((e) => `| \`${e.id}\` | ${e.date} | ${e.source} | ${e.kind} | ${cell(e.what)} | ${cell(e.outcome ?? "")} | ${e.link ?? ""} |`).join("\n")}`);

  return `${out.join("\n\n")}\n`;
}
