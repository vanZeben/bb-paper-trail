/**
 * marks.ts — the end-of-week marks, pure: the retro the judge returns, the unplanned share, and plan accuracy
 * (the per-week trend plus the plain calibration sentence that also feeds the next week's scan). No store, no SDK.
 */
import { LOW_SIGNAL_KINDS } from "../../capture/sources";
import type { PlanAccuracy, PlanResult, WeekPlan } from "../../types";
import { hitRate } from "./logic";

export type Retro = NonNullable<WeekPlan["retro"]>;

const clip = (text: string, max: number): string => (text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text);
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

export const RETRO_REPLY_EXAMPLE = `"planRetro":{"summary":"…","derailers":[{"text":"…","evidenceIds":["…"]}]}`;

/** How the judge is told to write the retro. */
export const RETRO_RULES = `PLAN RETRO. In planRetro give "summary" (two sentences at most: how the week went against the plan) and "derailers" (up to 4: the work that pulled the week off the plan, each with the evidence ids that show it). Use only evidence ids from the evidence block.`;

/** Unknown evidence ids are dropped; an empty retro is null. Never throws: a missing retro must not fail the judgment. */
export function validateRetro(raw: Record<string, unknown>, evidenceIds: ReadonlySet<string>): Retro | null {
  const r = raw.planRetro;
  if (typeof r !== "object" || r === null) return null;
  const e = r as Record<string, unknown>;
  const summary = typeof e.summary === "string" ? clip(oneLine(e.summary), 400) : "";
  const derailers: Retro["derailers"] = [];
  if (Array.isArray(e.derailers)) {
    for (const d of e.derailers) {
      if (typeof d !== "object" || d === null) continue;
      const x = d as Record<string, unknown>;
      const text = typeof x.text === "string" ? clip(oneLine(x.text), 200) : "";
      if (text === "") continue;
      const ids = Array.isArray(x.evidenceIds) ? [...new Set(x.evidenceIds.filter((i): i is string => typeof i === "string" && evidenceIds.has(i)))] : [];
      derailers.push({ text, evidenceIds: ids });
      if (derailers.length >= 4) break;
    }
  }
  if (summary === "" && derailers.length === 0) return null;
  return { summary, derailers };
}

/**
 * Substantive evidence (kind not low-signal) that no commitment's result cites, over all substantive evidence.
 * Null when the week has none. Rounded to 2 places.
 */
export function unplannedShare(evidence: ReadonlyArray<{ id: string; kind: string }>, results: readonly Pick<PlanResult, "evidenceIds">[]): number | null {
  const substantive = new Set(evidence.filter((e) => !LOW_SIGNAL_KINDS.includes(e.kind)).map((e) => e.id));
  if (substantive.size === 0) return null;
  const cited = new Set(results.flatMap((r) => r.evidenceIds));
  let uncited = 0;
  for (const id of substantive) if (!cited.has(id)) uncited++;
  return Math.round((uncited / substantive.size) * 100) / 100;
}

const pct = (v: number): string => `${Math.round(v * 100)}%`;

/** The plain calibration sentence for a set of judged weeks. */
export function calibrationNote(byWeek: PlanAccuracy["byWeek"], overall: number | null): string {
  const judged = byWeek.filter((w) => w.hitRate !== null);
  if (judged.length === 0 || overall === null) return "No judged weeks yet. Accuracy appears after the first end-of-week review.";
  const weeks = `${judged.length} week${judged.length === 1 ? "" : "s"}`;
  const avg = judged.reduce((n, w) => n + w.committed, 0) / judged.length;
  const typical = Math.max(1, Math.round(avg));
  if (overall < 0.6) {
    const fewer = Math.max(2, Math.round(avg * 0.6));
    return fewer < typical
      ? `Plans hit ${pct(overall)} over ${weeks}; it's been over-committing, so expect ${fewer} commitments, not ${typical}.`
      : `Plans hit ${pct(overall)} over ${weeks}; the marks are being missed even at ${typical} commitments, so expect sharper, smaller ones.`;
  }
  if (overall < 0.85) return `Plans hit ${pct(overall)} over ${weeks}; about right, so expect around ${typical} commitments with tight marks.`;
  return `Plans hit ${pct(overall)} over ${weeks}; the plans are reliable, so there is room for one stretch commitment.`;
}

/** Judged weeks that have commitments, oldest first. committed excludes dropped; hit counts "done" results. */
export function planAccuracy(plans: readonly WeekPlan[]): PlanAccuracy {
  const judged = [...plans].filter((p) => p.judgedAt !== null && p.items.length > 0).sort((a, b) => a.week.localeCompare(b.week));
  let score = 0;
  let total = 0;
  const byWeek = judged.map((p) => {
    const ids = new Set(p.items.map((i) => i.id));
    const mine = p.results.filter((r) => ids.has(r.itemId));
    const dropped = mine.filter((r) => r.status === "dropped").length;
    const done = mine.filter((r) => r.status === "done").length;
    const partial = mine.filter((r) => r.status === "partial").length;
    const committed = p.items.length - dropped;
    if (committed > 0) {
      score += done + 0.5 * partial;
      total += committed;
    }
    return { week: p.week, hitRate: hitRate(p.items, p.results), committed, hit: done };
  });
  const overall = total > 0 ? score / total : null;
  return { byWeek, overall, note: calibrationNote(byWeek, overall) };
}
