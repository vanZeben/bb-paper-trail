/**
 * markdown.ts — a review-ready markdown document from a ReviewPacket. Every claim line carries its evidence ids and
 * links; the appendix lists every cited id with its link.
 */
import type { EvidenceRef, ReviewPacket } from "../../types";

export const HONESTY = "AI-rated; your overrides applied; gaps listed.";
export const packetFilename = (from: string, to: string): string => `review-${from}-to-${to}.md`;

const RATING_TEXT: Record<string, string> = { exceeds: "Exceeds", meets: "Meets", needs_improvement: "Needs improvement", none: "No data" };
const STATUS_TEXT = { hit: "Hit", partial: "Partial", missed: "Missed" } as const;
const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const pct = (n: number): string => `${Math.round(n * 100)}%`;
const num = (n: number): string => `${Math.round(n * 10) / 10}`;

/** `[H1109-2](https://…)` for a linked ref, `` `H1109-2` `` for one without a link. */
export const refText = (r: EvidenceRef): string => (r.link === null ? `\`${r.id}\`` : `[${r.id}](${r.link})`);
const refs = (list: readonly EvidenceRef[]): string => (list.length === 0 ? "_no evidence cited_" : list.map(refText).join(", "));

const claimLine = (week: string, text: string, evidence: readonly EvidenceRef[]): string => `- ${week}: ${cell(text)} (${refs(evidence)})`;

export function packetMarkdown(packet: ReviewPacket, opts: { includeNarrative: boolean }): string {
  const out: string[] = [];
  out.push(`---\nfrom: ${packet.from}\nto: ${packet.to}\ngenerated: ${packet.generatedAt}\nframework: ${packet.frameworkId}\n---\n# Review packet ${packet.from} to ${packet.to}\n\n> ${HONESTY}`);

  if (opts.includeNarrative && packet.narrative !== null && packet.narrative.trim() !== "") {
    out.push(`## Self-assessment draft\n_Drafted by a model from this packet only; edit it before use._\n\n${packet.narrative.trim()}`);
  }

  // Summary
  const d = packet.ratingDistribution;
  const rated = Object.values(d).reduce((a, b) => a + b, 0);
  const o = packet.overrides;
  const rows: Array<[string, string]> = [
    ["Range", `${packet.from} to ${packet.to} (${packet.weeks.length} week${packet.weeks.length === 1 ? "" : "s"})`],
    ["Days rated", `${rated} (exceeds ${d.exceeds ?? 0}, meets ${d.meets ?? 0}, needs improvement ${d.needs_improvement ?? 0})`],
    ["Week ratings", packet.weekRatings.length === 0 ? "none yet" : packet.weekRatings.map((w) => `${w.week} ${RATING_TEXT[w.rating] ?? w.rating}${w.final ? "" : " (not final)"}`).join("; ")],
    ["Shipped", String(packet.shipped.length)],
    ["Decisions and influence", String(packet.decisions.length)],
    ["Helping others", String(packet.helpGiven.length)],
    ["Recognition", String(packet.recognition.length)],
    ["Work I added myself", String(packet.claimedWork.length)],
    ["Plan hit rate", packet.plan.hitRate === null ? "no judged plans" : pct(packet.plan.hitRate)],
    ["My review of the ratings", o.reviewed === 0 ? `none reviewed; ${o.unreviewed} rated days unreviewed` : `${o.reviewed} reviewed, ${o.confirmed} confirmed, ${o.overridden} changed (${o.raised} raised, ${o.lowered} lowered); ${o.unreviewed} rated days unreviewed`],
  ];
  out.push(`## Summary\n| Measure | Value |\n|---|---|\n${rows.map(([k, v]) => `| ${k} | ${cell(v)} |`).join("\n")}`);

  if (packet.heatmap.length > 0 && packet.weeks.length > 0) {
    const head = `| Area | ${packet.weeks.join(" | ")} |\n|---|${packet.weeks.map(() => "---").join("|")}|`;
    const body = packet.heatmap
      .map((a) => `| ${cell(a.label)} | ${a.cells.map((c) => (c.status === null ? "-" : `${STATUS_TEXT[c.status]}${c.overridden ? " (changed by me)" : ""}`)).join(" | ")} |`)
      .join("\n");
    out.push(`### Scorecard by week\n${head}\n${body}`);
  }

  // Highlights: the strongest claims, each with evidence.
  const highlights: string[] = [];
  for (const s of packet.shipped.filter((s) => s.closure?.outcome === "better" || s.closure?.outcome === "as_expected").slice(0, 3)) {
    highlights.push(`- Shipped: ${cell(s.title)} (${refs(s.evidence)})`);
  }
  for (const c of packet.recognition.slice(0, 3)) highlights.push(claimLine(c.week, `Recognised: ${c.text}`, c.evidence));
  for (const c of packet.decisions.slice(0, 3)) highlights.push(claimLine(c.week, `Decision: ${c.text}`, c.evidence));
  out.push(`## Highlights\n${highlights.length === 0 ? "_Nothing to highlight in this range yet._" : highlights.join("\n")}`);

  // Shipped
  out.push(
    `## Shipped\n${
      packet.shipped.length === 0
        ? "_Nothing marked shipped in this range._"
        : packet.shipped
            .map((s) => {
              const lines = [`- **${cell(s.title)}** (${s.weeks.join(", ")}): ${refs(s.evidence)}`];
              if (s.closure !== null) {
                lines.push(`  - Outcome: ${s.closure.outcome.replace("_", " ")}. Expected: ${cell(s.closure.expectation)} Result: ${cell(s.closure.result)}`);
                lines.push(`  - Learnings: ${cell(s.closure.learnings)}${s.closure.impact ? ` Impact: ${cell(s.closure.impact)}` : ""}`);
              } else if (s.threadId !== null) lines.push("  - No closure note yet.");
              return lines.join("\n");
            })
            .join("\n")
    }`,
  );

  if (packet.goals.length > 0) {
    out.push(
      `## Goals\n${packet.goals
        .map((g) => {
          const head = `- **${cell(g.text)}**: ${g.judgedWeeks === 0 ? "no judged weeks in this range" : `advanced in ${g.advancedWeeks} of ${g.judgedWeeks} judged week${g.judgedWeeks === 1 ? "" : "s"}`}`;
          const rows = g.weeks.map((w) => `  - ${w.week}: ${w.status === "advanced" ? "advanced" : "no movement"} (${refs(w.evidence)})`);
          return [head, ...rows].join("\n");
        })
        .join("\n")}`,
    );
  }

  const list = (title: string, items: ReviewPacket["decisions"], empty: string) =>
    out.push(`## ${title}\n${items.length === 0 ? `_${empty}_` : items.map((c) => claimLine(c.week, c.text, c.evidence)).join("\n")}`);
  list("Influence and decisions", packet.decisions, "No decisions recorded in this range.");
  list("Helping others", packet.helpGiven, "No help given recorded in this range.");
  list("Recognition", packet.recognition, "No recognition recorded in this range.");
  if (packet.claimedWork.length > 0) list("Work I added myself", packet.claimedWork, "");
  if (packet.uncreditedWork.length > 0) {
    out.push(
      `## Work no weekly summary mentioned\n_Found in the captured evidence; no weekly summary or plan cites it._\n\n${packet.uncreditedWork
        .map((u) => `- **${cell(u.label)}** (${u.count} item${u.count === 1 ? "" : "s"}, ${u.weeks.join(", ")}): ${u.items.map(refText).join(", ")}`)
        .join("\n")}`,
    );
  }

  // Time mix
  const labelOf = (key: string) => packet.heatmap.find((a) => a.area === key)?.label ?? key;
  const mixParts: string[] = [];
  if (packet.drift !== null) {
    const dr = packet.drift;
    const keys = [...new Set([...Object.keys(dr.target), ...Object.keys(dr.actual)])];
    mixParts.push(
      `Window: ${dr.windowWeeks} weeks to ${dr.week}. Drift score ${num(dr.score)} points (${dr.status}).\n\n| Area | Target | Actual | Drift (points) |\n|---|---|---|---|\n${keys
        .map((k) => `| ${cell(labelOf(k))} | ${num(dr.target[k] ?? 0)}% | ${num(dr.actual[k] ?? 0)}% | ${dr.perArea[k] === undefined ? "-" : (dr.perArea[k]! > 0 ? "+" : "") + num(dr.perArea[k]!)} |`)
        .join("\n")}`,
    );
  }
  if (packet.mix.length > 0) {
    mixParts.push(`| Week | Days counted | Drift (points) |\n|---|---|---|\n${packet.mix.map((m) => `| ${m.week} | ${m.daysCounted} | ${m.drift === null ? "-" : num(m.drift)} |`).join("\n")}`);
  }
  out.push(`## Time mix vs target\n${mixParts.length === 0 ? "_No time targets or mix data for this range._" : mixParts.join("\n\n")}`);

  out.push(
    `## Plan follow-through\n${packet.plan.hitRate === null ? "_No judged weekly plans in this range._" : `Hit rate ${pct(packet.plan.hitRate)} (done counts 1, partial 0.5, dropped items excluded).`}${
      packet.plan.carriedOver.length === 0 ? "" : `\n\nCarried over from earlier weeks:\n${packet.plan.carriedOver.map((t) => `- ${cell(t)}`).join("\n")}`
    }`,
  );

  out.push(`## Gaps in the record\n${packet.coverageGaps.length === 0 ? "_No failed or partial sources._" : packet.coverageGaps.map((g) => `- ${g}`).join("\n")}\n\n_An empty source is not proof of no work._`);

  // Appendix
  const all = new Map<string, EvidenceRef>();
  const take = (list: readonly EvidenceRef[]) => list.forEach((r) => all.set(`${r.date}|${r.id}`, r));
  packet.shipped.forEach((s) => take(s.evidence));
  for (const l of [packet.decisions, packet.recognition, packet.helpGiven, packet.claimedWork]) l.forEach((c) => take(c.evidence));
  packet.goals.forEach((g) => g.weeks.forEach((w) => take(w.evidence)));
  packet.uncreditedWork.forEach((u) => take(u.items));
  const sorted = [...all.values()].sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date.localeCompare(b.date)));
  out.push(`## Appendix: evidence cited\n${sorted.length === 0 ? "_None._" : `| ID | Date | Link |\n|---|---|---|\n${sorted.map((r) => `| \`${r.id}\` | ${r.date} | ${r.link ?? "no link"} |`).join("\n")}`}`);

  return `${out.join("\n\n")}\n`;
}
