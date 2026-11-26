/**
 * drafts.ts — closure drafts. A week-judge PromptExtension asks for one draft per finished piece of shipped work
 * (evidence only); the week hook saves each as a closure record with source "agent". User notes are never overwritten.
 */
import type { PromptCtx, PromptExtension } from "../../engine/extensions";
import { KIND } from "../../storage/port";
import { workDaySchema, type ClosureNote, type Thread } from "../../types";

export const MAX_DRAFTS = 5;
const OUTCOMES = ["better", "as_expected", "worse", "mixed"] as const;
export interface ClosureDraft {
  /** Text of the shipped claim this draft closes (matched against the judge's own `shipped` list). */
  claimText: string;
  outcome: ClosureNote["outcome"];
  expectation: string;
  result: string;
  learnings: string;
  impact?: string;
  evidenceIds: string[];
}
export const DRAFT_REPLY_EXAMPLE = `"closureDrafts":[{"threadKey":"<exact text of the shipped entry>","outcome":"better|as_expected|worse|mixed","expectation":"…","result":"…","learnings":"…","impact":"…","evidenceIds":["…"]}]`;
export const DRAFT_RULES = `CLOSURE DRAFTS: for each entry you put in "shipped" that finishes a piece of work of real size (not a typo fix or a routine merge), add a closureDrafts entry, at most ${MAX_DRAFTS}. threadKey is the exact text of that shipped entry. Draft expectation (what was meant to happen), result (what the evidence shows happened) and learnings from the evidence only; cite evidence ids, at least one. If the evidence does not show an expectation or result, leave that work out. impact is optional, one line.`;

const clip = (t: string, n: number): string => (t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t);
const norm = (t: string): string => t.replace(/\s+/g, " ").trim().toLowerCase();
const str = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

/**
 * The shipped entry a draft closes: the same text (normalised), else the one entry that shares the most cited evidence ids
 * with the draft (at least one, and no tie). A substring is never enough: "fix" would bind to any entry containing it.
 */
function claimFor(key: string, draftIds: readonly string[], shipped: ReadonlyArray<{ text: string; evidenceIds: string[] }>): string | undefined {
  const exact = key === "" ? undefined : shipped.find((c) => norm(c.text) === key);
  if (exact !== undefined) return exact.text;
  const scored = shipped.map((c) => ({ text: c.text, n: c.evidenceIds.filter((id) => draftIds.includes(id)).length })).filter((c) => c.n > 0);
  const best = Math.max(0, ...scored.map((c) => c.n));
  const top = scored.filter((c) => c.n === best);
  return top.length === 1 ? top[0]!.text : undefined;
}

/** Drops drafts that name no shipped entry, cite no known evidence, or lack expectation, result or learnings. */
export function validateClosureDrafts(raw: Record<string, unknown>, evidenceIds: ReadonlySet<string>): ClosureDraft[] {
  const list = raw.closureDrafts;
  if (!Array.isArray(list)) return [];
  const shipped = (Array.isArray(raw.shipped) ? raw.shipped : [])
    .map((c) => {
      const r = (c ?? {}) as { text?: unknown; evidenceIds?: unknown };
      return { text: str(r.text), evidenceIds: Array.isArray(r.evidenceIds) ? r.evidenceIds.filter((x): x is string => typeof x === "string") : [] };
    })
    .filter((c) => c.text !== "");
  const out: ClosureDraft[] = [];
  for (const e of list) {
    if (typeof e !== "object" || e === null) continue;
    const r = e as Record<string, unknown>;
    const key = norm(str(r.threadKey));
    const expectation = str(r.expectation);
    const result = str(r.result);
    const learnings = str(r.learnings);
    const ids = Array.isArray(r.evidenceIds) ? [...new Set(r.evidenceIds.filter((x): x is string => typeof x === "string" && evidenceIds.has(x)))] : [];
    const claim = claimFor(key, ids, shipped);
    if (claim === undefined || expectation === "" || result === "" || learnings === "" || ids.length === 0) continue;
    if (out.some((d) => d.claimText === claim)) continue;
    const impact = str(r.impact);
    out.push({
      claimText: claim,
      outcome: OUTCOMES.find((o) => o === r.outcome) ?? "as_expected",
      expectation: clip(expectation, 400), result: clip(result, 400), learnings: clip(learnings, 800),
      ...(impact === "" ? {} : { impact: clip(impact, 200) }),
      evidenceIds: ids,
    });
    if (out.length >= MAX_DRAFTS) break;
  }
  return out;
}

export function createClosureDraftsPrompt(): PromptExtension {
  const byCtx = new WeakMap<PromptCtx, Set<string>>();
  const byWeek = new Map<string, Set<string>>();
  return {
    id: "closures",
    async weekRules(ctx) {
      const days = await Promise.all(ctx.dates.map((d) => ctx.store.get(KIND.day, d, workDaySchema)));
      const ids = new Set(days.flatMap((d) => (d === null ? [] : d.evidence.map((x) => x.id))));
      byCtx.set(ctx, ids);
      byWeek.set(ctx.week, ids);
      return DRAFT_RULES;
    },
    weekReplyExample: () => DRAFT_REPLY_EXAMPLE,
    validateWeekExtra(raw, ctx) {
      return validateClosureDrafts(raw, byCtx.get(ctx) ?? byWeek.get(ctx.week) ?? new Set());
    },
  };
}

/** The thread whose shipped entry in `week` is this draft's claim (same text, or sharing evidence with it). */
export function threadForDraft(draft: ClosureDraft, week: { week: string; shipped: ReadonlyArray<{ text: string; evidenceIds: string[] }> }, threads: readonly Thread[]): Thread | undefined {
  const claim = week.shipped.find((c) => c.text === draft.claimText);
  if (claim === undefined) return undefined;
  return threads.find((t) =>
    t.weeks.some((e) => e.week === week.week && e.state === "shipped" && (e.text === claim.text || e.evidenceIds.some((id) => claim.evidenceIds.includes(id)))),
  );
}
