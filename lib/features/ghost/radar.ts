/**
 * radar.ts — invisible work: pure candidate selection, bucketing, clustering and dedupe. No I/O, no model.
 *
 * A candidate is an evidence entry (from stored days and weeks) that no week claim, scorecard row, day rating or plan
 * result cites, that belongs to no thread, and whose kind is not low-signal. Addenda claims do NOT count as citations:
 * claiming a cluster must not make it vanish on the next rebuild.
 * Each candidate lands in exactly one bucket: `repo:` / `channel:` / `doc:` from its link or text, else `kind:`.
 */
import { LOW_SIGNAL_KINDS } from "../../capture/sources";
import { isoWeekOf } from "../../engine/dates";
import type { EvidenceEntry, GhostCluster, Thread, WeekPlan, WorkDay, WorkWeek } from "../../types";

export const MIN_ITEMS = 3;
export const MIN_WEEKS = 2;
/** Keep an existing cluster's id and state when the new cluster shares more than this share of its smaller side. */
export const OVERLAP_KEEP = 0.5;
export const KIND_BUCKETS: readonly string[] = ["help_given", "review", "decision"];

export interface Candidate {
  week: string;
  date: string;
  id: string;
  kind: string;
  what: string;
  link: string | null;
  bucket: string;
}

export interface RadarInput {
  days: readonly WorkDay[];
  weeks: readonly WorkWeek[];
  plans: readonly WeekPlan[];
  threads: readonly Thread[];
}

const citeKey = (week: string, id: string) => `${week}:${id}`;
const itemKey = (i: { date: string; id: string }) => `${i.date}|${i.id}`;

/** Every `${week}:${id}` that a rating, claim, scorecard row or plan result already cites. */
export function citedKeys(input: Pick<RadarInput, "days" | "weeks" | "plans">): Set<string> {
  const out = new Set<string>();
  for (const day of input.days) for (const id of day.rating?.evidenceIds ?? []) out.add(citeKey(isoWeekOf(day.date), id));
  for (const w of input.weeks) {
    const add = (ids: readonly string[]) => ids.forEach((id) => out.add(citeKey(w.week, id)));
    for (const d of w.days) add(d.evidenceIds);
    for (const s of w.scorecard) add(s.evidenceIds);
    for (const list of [w.shipped, w.inProgress, w.decisions, w.helping, w.recognition, w.openAsks, w.friction, w.raiseWithManager]) {
      for (const c of list) add(c.evidenceIds);
    }
    for (const p of w.plan) add(p.evidenceIds);
  }
  for (const plan of input.plans) for (const r of plan.results) for (const id of r.evidenceIds) out.add(citeKey(plan.week, id));
  return out;
}

/** "pr:o/r#5" / "jira:ABC-1" keys that a link would produce in a thread. */
export function linkKeys(link: string | null): string[] {
  if (link === null) return [];
  const keys: string[] = [];
  const pr = /^https:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(link);
  if (pr) keys.push(`pr:${pr[1]}#${pr[2]}`);
  const jira = /\/browse\/([A-Z][A-Z0-9_]+-\d+)/.exec(link);
  if (jira) keys.push(`jira:${jira[1]}`);
  return keys;
}

/** Evidence ids and links that belong to a thread. */
function threadMembers(threads: readonly Thread[]) {
  const ids = new Set<string>();
  const links = new Set<string>();
  const keys = new Set<string>();
  for (const t of threads) {
    for (const k of t.keys) keys.add(k);
    for (const l of t.links) links.add(l);
    for (const w of t.weeks) for (const id of w.evidenceIds) ids.add(citeKey(w.week, id));
  }
  return { ids, links, keys };
}

/** The bucket an entry falls in, or null when it has none. */
export function bucketOf(e: Pick<EvidenceEntry, "kind" | "what" | "link" | "source">): string | null {
  const link = e.link;
  if (link !== null) {
    const pr = /^https:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/.exec(link);
    if (pr) return `repo:${pr[1]!.toLowerCase()}`;
  }
  if (e.source === "slack" || (link !== null && /\/archives\/[A-Z0-9]+/.test(link))) {
    const named = /^#([\w.-]+)/.exec(e.what);
    if (named) return `channel:${named[1]!.toLowerCase()}`;
    const id = link === null ? null : /\/archives\/([A-Z0-9]+)/.exec(link)?.[1];
    if (id) return `channel:${id}`;
  }
  if (link !== null) {
    const conf = /^https:\/\/([^/]+)\/wiki\/spaces\/[^/]+\/pages\/(\d+)/.exec(link);
    if (conf) return `doc:${conf[1]}/${conf[2]}`;
    const gdoc = /^https:\/\/docs\.google\.com\/(?:document|spreadsheets|presentation)\/d\/([\w-]+)/.exec(link);
    if (gdoc) return `doc:docs.google.com/${gdoc[1]}`;
  }
  if (KIND_BUCKETS.includes(e.kind)) return `kind:${e.kind}`;
  return null;
}

/** Evidence entries from days first, then any only a week carries; each (date, id) once. */
function allEvidence(days: readonly WorkDay[], weeks: readonly WorkWeek[]): EvidenceEntry[] {
  const seen = new Set<string>();
  const out: EvidenceEntry[] = [];
  for (const list of [...days.map((d) => d.evidence), ...weeks.map((w) => w.evidence)]) {
    for (const e of list) {
      const k = itemKey(e);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(e);
    }
  }
  return out;
}

export function candidates(input: RadarInput): Candidate[] {
  const cited = citedKeys(input);
  const members = threadMembers(input.threads);
  const out: Candidate[] = [];
  for (const e of allEvidence(input.days, input.weeks)) {
    if (LOW_SIGNAL_KINDS.includes(e.kind)) continue;
    const week = isoWeekOf(e.date);
    if (cited.has(citeKey(week, e.id)) || members.ids.has(citeKey(week, e.id))) continue;
    if (e.link !== null && members.links.has(e.link)) continue;
    if (linkKeys(e.link).some((k) => members.keys.has(k))) continue;
    const bucket = bucketOf(e);
    if (bucket === null) continue;
    out.push({ week, date: e.date, id: e.id, kind: e.kind, what: e.what, link: e.link, bucket });
  }
  return out.sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date.localeCompare(b.date)));
}

const NOUNS: Record<string, [string, string]> = {
  review: ["code review", "code reviews"],
  review_pending: ["code review", "code reviews"],
  pr_opened: ["pull request", "pull requests"],
  pr_merged: ["pull request", "pull requests"],
  help_given: ["time helping others", "times helping others"],
  decision: ["decision", "decisions"],
  doc_created: ["doc update", "doc updates"],
  doc_edited: ["doc update", "doc updates"],
  doc_commented: ["doc update", "doc updates"],
};

/** Slack conversations that are not named channels, by bucket target. */
const CONVERSATION_BUCKETS: Record<string, string> = {
  dm: "direct-message thread",
  im: "direct-message thread",
  group: "group-message thread",
  mpim: "group-message thread",
  mpdm: "group-message thread",
};

export function labelFor(bucket: string, items: ReadonlyArray<{ kind: string }>): string {
  const nouns = new Set(items.map((i) => NOUNS[i.kind]?.[0] ?? "item"));
  const noun = nouns.size === 1 ? (NOUNS[items[0]!.kind] ?? ["item", "items"]) : ["item", "items"];
  const what = `${items.length} ${items.length === 1 ? noun[0] : noun[1]}`;
  const [type, target] = [bucket.slice(0, bucket.indexOf(":")), bucket.slice(bucket.indexOf(":") + 1)];
  if (type === "repo") return `${what} in ${target}`;
  if (type === "channel") {
    // Direct and group messages are not channels: never "#dm" / "#group".
    const dm = CONVERSATION_BUCKETS[target];
    if (dm !== undefined) return `${items.length} ${dm}${items.length === 1 ? "" : "s"}`;
    return `${what} in #${target}`;
  }
  if (type === "doc") return `${what} on ${target}`;
  return what;
}

/** Stable id derived from the bucket and the first item. */
export function clusterId(bucket: string, first: { date: string; id: string }): string {
  let h = 5381;
  for (const ch of `${bucket}|${first.date}|${first.id}`) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return `gh-${h.toString(16).padStart(8, "0")}`;
}

/** Group candidates by bucket and keep groups of >= 3 items or >= 2 weeks. */
export function clusterCandidates(cands: readonly Candidate[]): GhostCluster[] {
  const by = new Map<string, Candidate[]>();
  for (const c of cands) by.set(c.bucket, [...(by.get(c.bucket) ?? []), c]);
  const out: GhostCluster[] = [];
  for (const [bucket, items] of by) {
    const weeks = [...new Set(items.map((i) => i.week))].sort();
    if (items.length < MIN_ITEMS && weeks.length < MIN_WEEKS) continue;
    out.push({
      id: clusterId(bucket, items[0]!),
      bucket,
      label: labelFor(bucket, items),
      items: items.map((i) => ({ date: i.date, id: i.id, link: i.link, week: i.week, kind: i.kind, what: i.what })),
      weeks,
      count: items.length,
      state: "new",
      claimedAs: null,
      claimedWeek: null,
    });
  }
  return out.sort((a, b) => b.count - a.count || a.bucket.localeCompare(b.bucket));
}

const overlap = (a: GhostCluster, b: GhostCluster): number => {
  const ka = new Set(a.items.map(itemKey));
  let shared = 0;
  for (const i of b.items) if (ka.has(itemKey(i))) shared += 1;
  return shared / Math.max(1, Math.min(a.items.length, b.items.length));
};

/**
 * A fresh cluster that overlaps an existing one by more than 50% takes over that cluster's id and state (a dismissed
 * cluster stays dismissed as it grows). Existing claimed or dismissed clusters with no match are kept as they are;
 * unmatched "new" ones go away (`remove`).
 */
export function mergeWithExisting(fresh: readonly GhostCluster[], existing: readonly GhostCluster[]): { clusters: GhostCluster[]; remove: string[] } {
  const used = new Set<string>();
  const clusters: GhostCluster[] = [];
  for (const f of fresh) {
    let best: GhostCluster | null = null;
    let bestScore = OVERLAP_KEEP;
    for (const e of existing) {
      if (used.has(e.id)) continue;
      const score = overlap(e, f);
      if (score > bestScore) {
        best = e;
        bestScore = score;
      }
    }
    if (best === null) {
      clusters.push(f);
      continue;
    }
    used.add(best.id);
    clusters.push({ ...f, id: best.id, state: best.state, claimedAs: best.claimedAs, claimedWeek: best.claimedWeek });
  }
  const remove: string[] = [];
  for (const e of existing) {
    if (used.has(e.id)) continue;
    if (e.state === "new") remove.push(e.id);
    else clusters.push(e);
  }
  return { clusters, remove };
}

export function buildGhosts(input: RadarInput, existing: readonly GhostCluster[]): { clusters: GhostCluster[]; remove: string[] } {
  return mergeWithExisting(clusterCandidates(candidates(input)), existing);
}
