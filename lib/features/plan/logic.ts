/**
 * logic.ts — pure plan logic: item normalisation, carry-over, push dedupe, hit rate, stats, the judge-reply validator
 * and the per-day "advanced" counts. No store, no SDK, and no value imports (the app bundle uses it; judge prompt text lives in rules.ts); handlers and hooks stay thin around these functions.
 */
import type { PlanItem, PlanResult, WeekPlan } from "./types";

export const MAX_ITEMS = 7;
export const MAX_ITEM_TEXT = 200;
export const MAX_NOTE = 200;
export const PLAN_STATUSES = ["done", "partial", "not_done", "dropped"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const emptyPlan = (week: string): WeekPlan => ({
  week, items: [], results: [], hitRate: null, judgedAt: null,
  intent: null, shape: null, backlog: null, retro: null, unplannedShare: null, plannedAt: null, plannedFor: null,
});

/** The fields every plan item carries beyond its text; manual and pushed items start with none of them. */
export const NO_COMMITMENT_FIELDS = { goalId: null, taskId: null, kind: "other" as const, doneWhen: "", refs: [] };

const clip = (text: string, max: number): string => (text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text);
const norm = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();

let counter = 0;
/** A fresh item id. Not deterministic on purpose; tests inject their own. */
export const randomItemId = (): string => `pi-${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Results that count as unfinished for carry-over. In a judged week an item with no result counts as not done. */
export function unfinishedItems(plan: WeekPlan | null): PlanItem[] {
  if (plan === null) return [];
  const judged = plan.judgedAt !== null;
  return plan.items.filter((item) => {
    const r = plan.results.find((x) => x.itemId === item.id);
    if (r === undefined) return judged;
    return r.status === "not_done" || r.status === "partial";
  });
}

export interface CarryCandidate {
  /** The previous week's item id. Send it as `id` in plan.set to link the carried item. */
  fromId: string;
  text: string;
  area: string | null;
  carryCount: number;
  carriedFrom: string;
}

/** Last week's unfinished items, offered for this week: carryCount + 1 and carriedFrom the old item. */
export function carryOverCandidates(prev: WeekPlan | null): CarryCandidate[] {
  return unfinishedItems(prev).map((item) => ({ fromId: item.id, text: item.text, area: item.area, carryCount: item.carryCount + 1, carriedFrom: item.id }));
}

export interface SetItemInput {
  id?: string | undefined;
  text: string;
  area?: string | null | undefined;
}

/**
 * Build the item list for plan.set. An input with an id that already exists in this week keeps its provenance; an id
 * (or, failing that, the same text) that matches an unfinished item of the previous week makes a carried item with
 * carryCount + 1; anything else is a new manual item with a fresh id. Blank lines are dropped; at most 7 are kept.
 */
export function buildItems(
  week: string,
  inputs: readonly SetItemInput[],
  existing: readonly PlanItem[],
  prev: WeekPlan | null,
  now: string,
  newId: () => string = randomItemId,
): PlanItem[] {
  const byId = new Map(existing.map((i) => [i.id, i]));
  const unfinished = unfinishedItems(prev);
  const unfinishedById = new Map(unfinished.map((i) => [i.id, i]));
  const usedCarry = new Set<string>();
  const usedIds = new Set<string>();
  const out: PlanItem[] = [];
  for (const input of inputs) {
    const text = clip(input.text.replace(/\s+/g, " ").trim(), MAX_ITEM_TEXT);
    if (text === "") continue;
    if (out.length >= MAX_ITEMS) break;
    const area = input.area === undefined || input.area === "" ? null : input.area;
    const kept = input.id === undefined ? undefined : byId.get(input.id);
    // A repeated existing id falls through and gets a fresh one, so ids stay unique.
    if (kept !== undefined && !usedIds.has(kept.id)) {
      usedIds.add(kept.id);
      const nextArea = input.area === undefined ? kept.area : area;
      // The user changed an agent-proposed intention: from now on it is theirs.
      const source = kept.source === "inferred" && (text !== kept.text || nextArea !== kept.area) ? ("manual" as const) : kept.source;
      out.push({ ...kept, text, area: nextArea, source });
      continue;
    }
    let from = input.id === undefined ? undefined : unfinishedById.get(input.id);
    if (from === undefined) from = unfinished.find((u) => !usedCarry.has(u.id) && norm(u.text) === norm(text));
    // A text match must not steal an item the user already has under another id.
    if (from !== undefined && usedCarry.has(from.id)) from = undefined;
    if (from !== undefined) usedCarry.add(from.id);
    let id = newId();
    while (usedIds.has(id) || byId.has(id)) id = newId();
    usedIds.add(id);
    out.push({
      id,
      week,
      text,
      area,
      source: "manual",
      externalRef: null,
      carriedFrom: from?.id ?? null,
      carryCount: from === undefined ? 0 : from.carryCount + 1,
      createdAt: now,
      ...NO_COMMITMENT_FIELDS,
    });
  }
  return out;
}

/** plan.push: add external items, skipping any externalRef already in the week and anything past the cap of 7. */
export function pushItems(
  week: string,
  existing: readonly PlanItem[],
  incoming: ReadonlyArray<{ text: string; externalRef: string }>,
  now: string,
  newId: () => string = randomItemId,
): { items: PlanItem[]; added: number; skipped: number } {
  const items = [...existing];
  const refs = new Set(items.flatMap((i) => (i.externalRef === null ? [] : [i.externalRef])));
  let added = 0;
  let skipped = 0;
  for (const inc of incoming) {
    const text = clip(inc.text.replace(/\s+/g, " ").trim(), MAX_ITEM_TEXT);
    if (text === "" || refs.has(inc.externalRef) || items.length >= MAX_ITEMS) {
      skipped++;
      continue;
    }
    refs.add(inc.externalRef);
    items.push({ id: newId(), week, text, area: null, source: "external", externalRef: inc.externalRef, carriedFrom: null, carryCount: 0, createdAt: now, ...NO_COMMITMENT_FIELDS });
    added++;
  }
  return { items, added, skipped };
}

/** (done + 0.5 × partial) / (items − dropped); null when nothing is judgeable. Items with no result score 0. */
export function hitRate(items: readonly Pick<PlanItem, "id">[], results: readonly PlanResult[]): number | null {
  const ids = new Set(items.map((i) => i.id));
  const mine = results.filter((r) => ids.has(r.itemId));
  const dropped = mine.filter((r) => r.status === "dropped").length;
  const denom = items.length - dropped;
  if (items.length === 0 || denom <= 0) return null;
  const done = mine.filter((r) => r.status === "done").length;
  const partial = mine.filter((r) => r.status === "partial").length;
  return (done + 0.5 * partial) / denom;
}

/** Numerator and denominator of the hit rate, for pooling across weeks. */
export function hitParts(plan: WeekPlan): { score: number; total: number } | null {
  if (plan.judgedAt === null || plan.items.length === 0) return null;
  const ids = new Set(plan.items.map((i) => i.id));
  const mine = plan.results.filter((r) => ids.has(r.itemId));
  const dropped = mine.filter((r) => r.status === "dropped").length;
  const total = plan.items.length - dropped;
  if (total <= 0) return null;
  return { score: mine.filter((r) => r.status === "done").length + 0.5 * mine.filter((r) => r.status === "partial").length, total };
}

export interface PlanStats {
  hitRate: number | null;
  byWeek: Array<{ week: string; hitRate: number | null }>;
  carriedOver: Array<{ text: string; carryCount: number; firstWeek: string }>;
}

/** Stats over the given plan records (already limited to the window). byWeek lists weeks that have items. */
export function planStats(plans: readonly WeekPlan[]): PlanStats {
  const sorted = [...plans].filter((p) => p.items.length > 0).sort((a, b) => a.week.localeCompare(b.week));
  let score = 0;
  let total = 0;
  const byWeek = sorted.map((p) => {
    const parts = hitParts(p);
    if (parts !== null) {
      score += parts.score;
      total += parts.total;
    }
    return { week: p.week, hitRate: p.judgedAt === null ? null : hitRate(p.items, p.results) };
  });

  // "Keeps carrying over": the open end of every carry chain that has been carried at least once and never finished.
  const all = new Map<string, PlanItem>();
  const carriedOn = new Set<string>();
  for (const p of sorted) for (const i of p.items) all.set(i.id, i);
  for (const i of all.values()) if (i.carriedFrom !== null) carriedOn.add(i.carriedFrom);
  const resultOf = new Map<string, PlanResult>();
  for (const p of sorted) for (const r of p.results) resultOf.set(r.itemId, r);
  const carriedOver: PlanStats["carriedOver"] = [];
  for (const i of all.values()) {
    if (i.carryCount < 1 || carriedOn.has(i.id)) continue;
    const status = resultOf.get(i.id)?.status;
    if (status === "done" || status === "dropped") continue;
    let root = i;
    const seen = new Set<string>();
    while (root.carriedFrom !== null && !seen.has(root.id)) {
      seen.add(root.id);
      const up = all.get(root.carriedFrom);
      if (up === undefined) break;
      root = up;
    }
    carriedOver.push({ text: i.text, carryCount: i.carryCount, firstWeek: root.week });
  }
  carriedOver.sort((a, b) => b.carryCount - a.carryCount || a.firstWeek.localeCompare(b.firstWeek));
  return { hitRate: total > 0 ? score / total : null, byWeek, carriedOver };
}

export interface PlanValidationCtx {
  itemIds: ReadonlySet<string>;
  evidenceIds: ReadonlySet<string>;
}

/**
 * Validates `raw.plan` from the week judgment. Unknown itemIds and unknown evidence ids are dropped, a repeated itemId
 * keeps its first entry, a bad status drops the entry, and a `done` with no evidence is downgraded to `partial`.
 */
export function validatePlanResults(raw: Record<string, unknown>, ctx: PlanValidationCtx): PlanResult[] {
  const list = raw.plan;
  if (!Array.isArray(list)) return [];
  const out: PlanResult[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const itemId = typeof e.itemId === "string" ? e.itemId : "";
    if (!ctx.itemIds.has(itemId) || seen.has(itemId)) continue;
    const status = e.status;
    if (typeof status !== "string" || !(PLAN_STATUSES as readonly string[]).includes(status)) continue;
    seen.add(itemId);
    const ids = Array.isArray(e.evidenceIds) ? [...new Set(e.evidenceIds.filter((x): x is string => typeof x === "string" && ctx.evidenceIds.has(x)))] : [];
    const note = typeof e.note === "string" ? clip(e.note.replace(/\s+/g, " ").trim(), MAX_NOTE) : "";
    const final: PlanStatus = status === "done" && ids.length === 0 ? "partial" : (status as PlanStatus);
    out.push({ itemId, status: final, note, evidenceIds: ids });
  }
  return out;
}

/** Count, per date, the done/partial results that cite evidence from that date. A result counts once per date. */
export function advancedByDate(results: readonly PlanResult[], evidence: ReadonlyArray<{ id: string; date: string }>): Map<string, number> {
  const dateOf = new Map(evidence.map((e) => [e.id, e.date]));
  const out = new Map<string, number>();
  for (const r of results) {
    if (r.status !== "done" && r.status !== "partial") continue;
    for (const date of new Set(r.evidenceIds.flatMap((id) => (dateOf.has(id) ? [dateOf.get(id)!] : [])))) out.set(date, (out.get(date) ?? 0) + 1);
  }
  return out;
}

/** The one-line summary for the Graph tab prompt; null when the week has no intentions. */
export function planSummary(plan: Pick<WeekPlan, "items" | "results">): string | null {
  const n = plan.items.length;
  if (n === 0) return null;
  const adv = plan.results.filter((r) => r.status === "done" || r.status === "partial").length;
  return `${n} intention${n === 1 ? "" : "s"} · ${adv} advanced so far`;
}
