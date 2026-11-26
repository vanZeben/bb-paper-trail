/**
 * build.ts — the review packet, built deterministically from stored records. No I/O, no model. Every claim keeps its
 * evidence refs `{date, id, link}`; effective ratings apply the user's overrides; gaps list failed or partial sources
 * (an `off` source is a choice, never a gap).
 */
import { addDays, isoWeekOf, weekMonday } from "../../engine/dates";
import { NOT_CAPTURED, RATINGS } from "../../types";
import type {
  AreaSnapshot, ClosureNote, DriftSnapshot, EvidenceRef, GhostCluster, Goal, Override, OverrideStats, ReviewPacket, Thread, WeekAddenda, WeekMix, WeekPlan, WorkDay, WorkWeek,
} from "../../types";

export interface PacketRecords {
  frameworkId: string;
  /** Area keys and labels, in display order. Areas seen only in stored scorecards are appended. */
  areas: readonly AreaSnapshot[];
  days: readonly WorkDay[];
  weeks: readonly WorkWeek[];
  overrides: readonly Override[];
  addenda: readonly WeekAddenda[];
  /** null = no threads record exists (fall back to the weekly shipped claims). */
  threads: readonly Thread[] | null;
  closures: readonly ClosureNote[];
  plans: readonly WeekPlan[];
  mix: readonly WeekMix[];
  /** The current goals (record goals/active). Progress comes from each week's ext.goals. */
  goals?: readonly Goal[];
  /** Radar clusters; those still `new` become the uncredited-work section. */
  ghosts?: readonly GhostCluster[];
  drifts: readonly DriftSnapshot[];
  generatedAt: string;
  narrative?: string | null;
}

export interface PacketRange {
  from: string;
  to: string;
}

type Claim = ReviewPacket["decisions"][number];
const RANK: Record<string, number> = { needs_improvement: 0, meets: 1, exceeds: 2, missed: 0, partial: 1, hit: 2 };
const STATUSES = ["hit", "partial", "missed"] as const;
const isRating = (v: string): v is (typeof RATINGS)[number] => (RATINGS as readonly string[]).includes(v) && v !== "none";
const isStatus = (v: string): v is (typeof STATUSES)[number] => (STATUSES as readonly string[]).includes(v);

/** ISO weeks that overlap the range, oldest first. */
export function weeksInRange(range: PacketRange): string[] {
  const out: string[] = [];
  for (let d = range.from; d <= range.to && out.length < 120 * 7; d = addDays(d, 1)) {
    const w = isoWeekOf(d);
    if (out[out.length - 1] !== w) out.push(w);
  }
  return [...new Set(out)];
}

/** A date for an evidence id (C1109-2 -> the Nov 09 inside `week`'s year span), for ids no stored entry resolves. */
function dateFromId(week: string, id: string): string {
  const m = /^[A-Z](\d{2})(\d{2})-/.exec(id);
  const monday = weekMonday(week);
  if (!m) return monday;
  const year = Number(monday.slice(0, 4));
  for (const y of [year, year + 1, year - 1]) {
    const date = `${y}-${m[1]}-${m[2]}`;
    if (isoWeekOf(date) === week) return date;
  }
  return monday;
}

function evidenceIndex(records: PacketRecords) {
  const map = new Map<string, EvidenceRef>();
  const put = (week: string, e: { id: string; date: string; link: string | null }) => {
    const k = `${week}:${e.id}`;
    if (!map.has(k)) map.set(k, { date: e.date, id: e.id, link: e.link });
  };
  for (const d of records.days) for (const e of d.evidence) put(isoWeekOf(d.date), e);
  for (const w of records.weeks) for (const e of w.evidence) put(w.week, e);
  return (week: string, ids: readonly string[]): EvidenceRef[] =>
    [...new Set(ids)].map((id) => map.get(`${week}:${id}`) ?? { date: dateFromId(week, id), id, link: null });
}

export function buildPacket(range: PacketRange, records: PacketRecords): ReviewPacket {
  const weeks = weeksInRange(range);
  const inWeeks = new Set(weeks);
  const refs = evidenceIndex(records);
  const days = records.days.filter((d) => d.date >= range.from && d.date <= range.to).sort((a, b) => a.date.localeCompare(b.date));
  const storedWeeks = records.weeks.filter((w) => inWeeks.has(w.week)).sort((a, b) => a.week.localeCompare(b.week));
  const overrideById = new Map(records.overrides.map((o) => [o.id, o]));
  const overridden = (id: string, valid: (v: string) => boolean): string | null => {
    const o = overrideById.get(id);
    return o !== undefined && o.decision === "overridden" && valid(o.value) ? o.value : null;
  };

  // Effective day ratings.
  const ratingDistribution: Record<string, number> = Object.fromEntries(RATINGS.filter((r) => r !== "none").map((r) => [r, 0]));
  for (const d of days) {
    if (d.rating === null) continue;
    const eff = overridden(`day:${d.date}`, isRating) ?? d.rating.rating;
    if (eff === "none") continue;
    ratingDistribution[eff] = (ratingDistribution[eff] ?? 0) + 1;
  }

  const weekRatings = storedWeeks.map((w) => ({ week: w.week, rating: overridden(`week:${w.week}`, isRating) ?? w.rating, final: w.final }));

  // Area x week heatmap.
  const areaList: AreaSnapshot[] = [...records.areas];
  for (const w of storedWeeks) for (const s of w.scorecard) if (!areaList.some((a) => a.key === s.area)) areaList.push({ key: s.area, label: s.area });
  const heatmap = areaList.map((a) => ({
    area: a.key,
    label: a.label,
    cells: weeks.map((week) => {
      const stored = storedWeeks.find((w) => w.week === week)?.scorecard.find((s) => s.area === a.key);
      const over = overridden(`scorecard:${week}:${a.key}`, isStatus);
      const status = over ?? stored?.status ?? null;
      return { week, status: status !== null && isStatus(status) ? status : null, overridden: over !== null };
    }),
  }));

  // Shipped.
  const closureBy = new Map(records.closures.map((c) => [c.threadId, c]));
  const shipped: ReviewPacket["shipped"] = [];
  const shippedThreads = (records.threads ?? []).filter((t) => (t.status === "shipped" || t.status === "closed") && t.weeks.some((w) => inWeeks.has(w.week)));
  if (shippedThreads.length > 0) {
    for (const t of shippedThreads) {
      const inRange = t.weeks.filter((w) => inWeeks.has(w.week));
      shipped.push({
        title: t.title,
        threadId: t.id,
        weeks: inRange.map((w) => w.week),
        evidence: dedupeRefs(inRange.flatMap((w) => refs(w.week, w.evidenceIds))),
        closure: closureBy.get(t.id) ?? null,
      });
    }
  } else {
    for (const w of storedWeeks) {
      for (const c of w.shipped) shipped.push({ title: c.text, threadId: null, weeks: [w.week], evidence: refs(w.week, c.evidenceIds), closure: null });
    }
  }

  const fromWeeks = (pick: (w: WorkWeek) => WorkWeek["decisions"]): Claim[] =>
    storedWeeks.flatMap((w) => pick(w).map((c) => ({ week: w.week, text: c.text, evidence: refs(w.week, c.evidenceIds) })));
  const claimedWork: Claim[] = records.addenda
    .filter((a) => inWeeks.has(a.week))
    .sort((a, b) => a.week.localeCompare(b.week))
    .flatMap((a) => a.claimedWork.map((c) => ({ week: a.week, text: c.text, evidence: refs(a.week, c.evidenceIds) })));

  // Mix and drift.
  const mix = records.mix.filter((m) => inWeeks.has(m.week)).sort((a, b) => a.week.localeCompare(b.week));
  const drift = [...records.drifts].filter((d) => inWeeks.has(d.week)).sort((a, b) => b.week.localeCompare(a.week))[0] ?? null;

  const goals: ReviewPacket["goals"] = (records.goals ?? []).map((g) => {
    const rows: ReviewPacket["goals"][number]["weeks"] = [];
    for (const w of storedWeeks) {
      const list = Array.isArray(w.ext.goals) ? (w.ext.goals as Array<{ goalId?: unknown; status?: unknown; evidenceIds?: unknown }>) : [];
      const hit = list.find((x) => x.goalId === g.id);
      if (hit === undefined || (hit.status !== "advanced" && hit.status !== "no_movement")) continue;
      rows.push({ week: w.week, status: hit.status, evidence: refs(w.week, Array.isArray(hit.evidenceIds) ? hit.evidenceIds.filter((i): i is string => typeof i === "string") : []) });
    }
    return { goalId: g.id, text: g.text, area: g.area, weeks: rows, advancedWeeks: rows.filter((r) => r.status === "advanced").length, judgedWeeks: rows.length };
  });

  const uncreditedWork: ReviewPacket["uncreditedWork"] = [];
  for (const c of records.ghosts ?? []) {
    if (c.state !== "new") continue;
    const items = c.items.filter((i) => inWeeks.has(i.week));
    if (items.length === 0) continue;
    uncreditedWork.push({ id: c.id, label: c.label, count: items.length, weeks: [...new Set(items.map((i) => i.week))].sort(), items: items.slice(0, 8) });
  }
  uncreditedWork.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));

  return {
    from: range.from,
    to: range.to,
    generatedAt: records.generatedAt,
    frameworkId: records.frameworkId,
    weeks,
    ratingDistribution,
    weekRatings,
    heatmap,
    shipped,
    decisions: fromWeeks((w) => w.decisions),
    recognition: fromWeeks((w) => w.recognition),
    helpGiven: fromWeeks((w) => w.helping),
    claimedWork,
    mix,
    drift,
    plan: planStats(records.plans.filter((p) => inWeeks.has(p.week))),
    overrides: overrideStats(range, records.overrides, days, inWeeks),
    coverageGaps: coverageGaps(range, days, records.generatedAt),
    narrative: records.narrative ?? null,
    goals,
    uncreditedWork: uncreditedWork.slice(0, 10),
  };
}

function dedupeRefs(list: readonly EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  return list.filter((r) => {
    const k = `${r.date}|${r.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Hit rate = (done + 0.5 x partial) / (items - dropped), pooled over judged weeks. 0..1. */
export function planStats(plans: readonly WeekPlan[]): ReviewPacket["plan"] {
  let credit = 0;
  let total = 0;
  const carried = new Set<string>();
  for (const p of plans) {
    for (const item of p.items) {
      if (item.carryCount > 0) carried.add(item.text);
      if (p.judgedAt === null) continue;
      const status = p.results.find((r) => r.itemId === item.id)?.status;
      if (status === "dropped") continue;
      total += 1;
      credit += status === "done" ? 1 : status === "partial" ? 0.5 : 0;
    }
  }
  return { hitRate: total === 0 ? null : Math.round((credit / total) * 1000) / 1000, carriedOver: [...carried] };
}

export function overrideStats(range: PacketRange, overrides: readonly Override[], days: readonly WorkDay[], weeks: ReadonlySet<string>): OverrideStats {
  const inRange = overrides.filter((o) => {
    const t = o.target;
    return t.type === "day" ? t.date >= range.from && t.date <= range.to : weeks.has(t.week);
  });
  const confirmed = inRange.filter((o) => o.decision === "confirmed").length;
  const over = inRange.filter((o) => o.decision === "overridden");
  const dir = (o: Override) => (RANK[o.value] ?? 0) - (RANK[o.aiValue] ?? 0);
  const reviewedDays = new Set(inRange.filter((o) => o.target.type === "day").map((o) => (o.target as { date: string }).date));
  return {
    reviewed: inRange.length,
    confirmed,
    overridden: over.length,
    agreementRate: inRange.length === 0 ? null : Math.round((confirmed / inRange.length) * 1000) / 1000,
    raised: over.filter((o) => dir(o) > 0).length,
    lowered: over.filter((o) => dir(o) < 0).length,
    unreviewed: days.filter((d) => d.rating !== null && d.rating.rating !== "none" && !reviewedDays.has(d.date)).length,
  };
}

/**
 * Failed or partial sources per source, plus weekdays with no capture. Sources that are `off` never appear.
 * Sources that were never attempted (the NOT_CAPTURED sentinel) are worded "not captured on N days", apart from real failures.
 */
export function coverageGaps(range: PacketRange, days: readonly WorkDay[], generatedAt: string): string[] {
  const by = new Map<string, string[]>();
  const notCaptured = new Map<string, number>();
  for (const d of days) {
    for (const [source, c] of Object.entries(d.coverage)) {
      if (c.status === "failed" && c.note === NOT_CAPTURED.note) {
        notCaptured.set(source, (notCaptured.get(source) ?? 0) + 1);
        continue;
      }
      if (c.status !== "failed" && c.status !== "partial") continue;
      const k = `${source}|${c.status}`;
      by.set(k, [...(by.get(k) ?? []), d.date]);
    }
  }
  const out: string[] = [];
  for (const [k, dates] of [...by].sort(([a], [b]) => a.localeCompare(b))) {
    const [source, status] = k.split("|");
    out.push(`${source} was ${status} on ${dates.length} day${dates.length === 1 ? "" : "s"} (${dates.slice(0, 3).join(", ")}${dates.length > 3 ? ", ..." : ""}): evidence from it may be missing`);
  }
  for (const [source, n] of [...notCaptured].sort(([a], [b]) => a.localeCompare(b))) {
    out.push(`${source} not captured on ${n} day${n === 1 ? "" : "s"}: evidence from it may be missing`);
  }
  const have = new Set(days.map((d) => d.date));
  const last = generatedAt.slice(0, 10) < range.to ? generatedAt.slice(0, 10) : range.to;
  let missing = 0;
  for (let d = range.from; d <= last; d = addDays(d, 1)) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (dow >= 1 && dow <= 5 && !have.has(d)) missing += 1;
  }
  if (missing > 0) out.push(`${missing} weekday${missing === 1 ? "" : "s"} in the range have no captured record`);
  return out;
}

/** Every evidence id the packet cites. */
export function citedIds(packet: ReviewPacket): Set<string> {
  const ids = new Set<string>();
  for (const s of packet.shipped) s.evidence.forEach((e) => ids.add(e.id));
  for (const list of [packet.decisions, packet.recognition, packet.helpGiven, packet.claimedWork]) for (const c of list) c.evidence.forEach((e) => ids.add(e.id));
  for (const g of packet.goals) for (const w of g.weeks) w.evidence.forEach((e) => ids.add(e.id));
  for (const u of packet.uncreditedWork) u.items.forEach((e) => ids.add(e.id));
  return ids;
}
