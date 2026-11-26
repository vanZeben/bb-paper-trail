/**
 * lifecycle.ts — pure reconciliation of evaluations against stored results.
 *
 * - breach: upsert `${ruleId}:${week}`. An acknowledgement survives re-evaluation of the same week, and carries over
 *   to the next week of an ongoing streak (so it is not re-raised every week). firstBreachedWeek is the streak start.
 * - ok: resolves the rule's open/acknowledged results for this week and earlier weeks (recovery).
 * - skip: leaves everything as it is.
 * - rules that are disabled or removed: their open/acknowledged results are resolved.
 * Type-only imports, so the UI can share `currentResults`.
 */
import type { GuardrailResult, GuardrailRule, Severity } from "../../types";
import type { Evaluation } from "./rules";

const isLive = (r: GuardrailResult): boolean => r.state === "open" || r.state === "acknowledged";
export const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, breach: 2 };
export const resultId = (ruleId: string, week: string): string => `${ruleId}:${week}`;

export function reconcile(existing: readonly GuardrailResult[], evaluations: readonly Evaluation[], rules: readonly GuardrailRule[], week: string, now: string): GuardrailResult[] {
  const byId = new Map(existing.map((r) => [r.id, r]));
  const out = new Map<string, GuardrailResult>();
  const enabled = new Set(rules.filter((r) => r.enabled).map((r) => r.id));
  const resolve = (r: GuardrailResult) => out.set(r.id, { ...r, state: "resolved", at: now });

  for (const ev of evaluations) {
    if (ev.outcome === "skip") continue;
    if (ev.outcome === "ok") {
      for (const r of existing) if (r.ruleId === ev.ruleId && r.week <= week && isLive(r)) resolve(r);
      continue;
    }
    const id = resultId(ev.ruleId, week);
    const same = byId.get(id);
    const earlier = existing
      .filter((r) => r.ruleId === ev.ruleId && r.week < week && isLive(r))
      .sort((a, b) => (a.week < b.week ? 1 : -1))[0];
    let state: GuardrailResult["state"] = "open";
    let ackNote: string | null = null;
    if (same !== undefined && same.state !== "resolved") {
      state = same.state;
      ackNote = same.ackNote;
    } else if (same === undefined && earlier?.state === "acknowledged") {
      state = "acknowledged";
      ackNote = earlier.ackNote;
    }
    out.set(id, {
      id,
      ruleId: ev.ruleId,
      week,
      severity: ev.severity,
      title: ev.title,
      detail: ev.detail,
      evidence: ev.evidence,
      firstBreachedWeek: same?.firstBreachedWeek ?? earlier?.firstBreachedWeek ?? week,
      state,
      ackNote,
      at: now,
    });
  }
  for (const r of existing) if (isLive(r) && !enabled.has(r.ruleId) && !out.has(r.id)) resolve(r);
  return [...out.values()];
}

/** Acknowledge a result and the same rule's earlier live results (one acknowledgement per streak). */
export function acknowledge(existing: readonly GuardrailResult[], id: string, note: string, now: string): GuardrailResult[] | null {
  const target = existing.find((r) => r.id === id);
  if (target === undefined) return null;
  return existing
    .filter((r) => r.ruleId === target.ruleId && r.week <= target.week && r.state === "open")
    .map((r) => ({ ...r, state: "acknowledged" as const, ackNote: note, at: now }));
}

/** What the banner shows: per rule, the newest open result, worst severity first (then newest week). */
export function currentResults(results: readonly GuardrailResult[]): GuardrailResult[] {
  const latest = new Map<string, GuardrailResult>();
  for (const r of results) {
    if (r.state !== "open") continue;
    const prev = latest.get(r.ruleId);
    if (prev === undefined || r.week > prev.week) latest.set(r.ruleId, r);
  }
  return [...latest.values()].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || (a.week < b.week ? 1 : -1) || (a.id < b.id ? -1 : 1));
}
