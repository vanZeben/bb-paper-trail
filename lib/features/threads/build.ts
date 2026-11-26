/**
 * build.ts — pure thread derivation. Threads are never stored as truth: they are rebuilt from the week records, the
 * user's edits and the closure notes after every week save.
 *
 *  - Each shipped / in-progress claim takes the keys of the links of the evidence it cites. Claims that share a key
 *    (in any week) form one thread (union-find). A keyless claim is a one-week thread only if it shipped.
 *  - Status: dropped (an edit with a reason) > closed (has a closure) > shipped (latest claim is a ship, no closure)
 *    > stale (no claim for 3 weeks) > at_risk (in progress 4+ consecutive weeks, nothing shipped) > active.
 *  - Edits: title, mergeInto, hidden, extraKeys, drop. Edits and closures are found by any id the thread has ever had
 *    (the id of each of its claims), so a merge or a new claim never orphans them.
 */
import { addDays, isoWeekOf, weekMonday } from "../../engine/dates";
import type { ClosureNote, Thread, ThreadEdit, WorkWeek } from "../../types";
import { extractKeys } from "./keys";

export const STALE_AFTER_WEEKS = 3;
export const AT_RISK_WEEKS = 4;
export const MAX_TITLE = 120;

export type ThreadWeekInput = Pick<WorkWeek, "week" | "shipped" | "inProgress" | "evidence">;

export interface BuiltThreads {
  threads: Thread[];
  /** Every id a thread has had (claim ids, merged-away ids) mapped to its current id. */
  aliasToId: Map<string, string>;
}

interface Node {
  week: string;
  state: "in_progress" | "shipped";
  text: string;
  evidenceIds: string[];
  links: string[];
  keys: string[];
  claimId: string;
  order: number;
}

const clip = (text: string, max: number): string => (text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text);
const hash = (s: string): string => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
};

/** Whole weeks from `a` to `b` (positive when b is later). */
export function weeksBetween(a: string, b: string): number {
  return Math.round((Date.parse(weekMonday(b)) - Date.parse(weekMonday(a))) / (7 * 86_400_000));
}

class Dsu {
  private parent: number[] = [];
  add(): number {
    this.parent.push(this.parent.length);
    return this.parent.length - 1;
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]!]!;
      x = this.parent[x]!;
    }
    return x;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb); // the earlier claim stays the root
  }
}

/** The status a thread has, before edits that drop it. Exported for tests. */
export function lifecycleStatus(
  entries: ReadonlyArray<{ week: string; state: "in_progress" | "shipped" }>,
  todayWeek: string,
): "active" | "at_risk" | "shipped" | "stale" {
  const weeks = [...new Set(entries.map((e) => e.week))].sort();
  const last = weeks[weeks.length - 1]!;
  const shippedIn = (w: string) => entries.some((e) => e.week === w && e.state === "shipped");
  // A thread that shipped stays "shipped" (awaiting a closure note) however long ago, unless work resumed after.
  if (shippedIn(last)) return "shipped";
  if (weeksBetween(last, todayWeek) >= STALE_AFTER_WEEKS) return "stale";
  // In progress for consecutive weeks up to the last claim, with nothing shipped in that run.
  let streak = 0;
  for (let w = last; weeks.includes(w) && !shippedIn(w); w = isoWeekOf(addDays(weekMonday(w), -7))) streak++;
  return streak >= AT_RISK_WEEKS ? "at_risk" : "active";
}

export function buildThreadsDetailed(
  weeks: readonly ThreadWeekInput[],
  edits: readonly ThreadEdit[],
  closures: readonly ClosureNote[],
  todayWeek: string,
): BuiltThreads {
  const nodes: Node[] = [];
  const dsu = new Dsu();
  const sorted = [...weeks].sort((a, b) => a.week.localeCompare(b.week));
  for (const w of sorted) {
    const evidenceById = new Map(w.evidence.map((e) => [e.id, e]));
    const claims = [...w.shipped.map((c) => ({ c, state: "shipped" as const })), ...w.inProgress.map((c) => ({ c, state: "in_progress" as const }))];
    for (const { c, state } of claims) {
      const links = c.evidenceIds.flatMap((id) => {
        const link = evidenceById.get(id)?.link;
        return typeof link === "string" && link !== "" ? [link] : [];
      });
      const keys = extractKeys(links);
      if (keys.length === 0 && state !== "shipped") continue;
      const claimId = keys.length > 0 ? `th:${keys[0]}` : `th:${w.week}:${hash(c.text)}`;
      nodes.push({ week: w.week, state, text: c.text, evidenceIds: c.evidenceIds, links: [...new Set(links)], keys, claimId, order: dsu.add() });
    }
  }

  // Claims that share a key are one thread.
  const firstWithKey = new Map<string, number>();
  for (const n of nodes)
    for (const k of n.keys) {
      const seen = firstWithKey.get(k);
      if (seen === undefined) firstWithKey.set(k, n.order);
      else dsu.union(seen, n.order);
    }

  // Edits that join threads: mergeInto and extraKeys. Targets are looked up by any claim id.
  const nodeOfId = new Map<string, number>();
  for (const n of nodes) if (!nodeOfId.has(n.claimId)) nodeOfId.set(n.claimId, n.order);
  const extra = new Map<number, Set<string>>();
  for (const e of edits) {
    const at = nodeOfId.get(e.threadId);
    if (at === undefined) continue;
    if (e.mergeInto !== null && e.mergeInto !== "") {
      const into = nodeOfId.get(e.mergeInto);
      if (into !== undefined) dsu.union(at, into);
    }
    for (const k of e.extraKeys) {
      const key = k.trim();
      if (key === "") continue;
      const owner = firstWithKey.get(key);
      if (owner !== undefined) dsu.union(at, owner);
      const set = extra.get(at) ?? new Set<string>();
      set.add(key);
      extra.set(at, set);
    }
  }

  const groups = new Map<number, Node[]>();
  for (const n of nodes) {
    const root = dsu.find(n.order);
    groups.set(root, [...(groups.get(root) ?? []), n]);
  }
  const extraByRoot = new Map<number, Set<string>>();
  for (const [at, keys] of extra) {
    const root = dsu.find(at);
    const set = extraByRoot.get(root) ?? new Set<string>();
    for (const k of keys) set.add(k);
    extraByRoot.set(root, set);
  }

  const aliasToId = new Map<string, string>();
  const threads: Thread[] = [];
  for (const [root, group] of groups) {
    const id = group[0]!.claimId; // the earliest claim names the thread
    const aliases = new Set(group.map((n) => n.claimId));
    for (const a of aliases) aliasToId.set(a, id);

    // One entry per (week, state): same-week claims fold together.
    const entries: Thread["weeks"] = [];
    for (const n of group) {
      const hit = entries.find((e) => e.week === n.week && e.state === n.state);
      if (hit === undefined) entries.push({ week: n.week, state: n.state, text: n.text, evidenceIds: [...new Set(n.evidenceIds)] });
      else hit.evidenceIds = [...new Set([...hit.evidenceIds, ...n.evidenceIds])];
    }
    entries.sort((a, b) => a.week.localeCompare(b.week) || (a.state === b.state ? 0 : a.state === "in_progress" ? -1 : 1));

    const keys = [...new Set([...group.flatMap((n) => n.keys), ...(extraByRoot.get(root) ?? [])])];
    const links = [...new Set(group.flatMap((n) => n.links))];
    const lastShipped = [...entries].reverse().find((e) => e.state === "shipped");
    let title = clip((lastShipped ?? entries[entries.length - 1]!).text, MAX_TITLE);
    let hidden = false;
    let drop: string | null = null;
    for (const e of edits) {
      if (!aliases.has(e.threadId)) continue;
      if (e.title !== null && e.title.trim() !== "") title = clip(e.title.trim(), MAX_TITLE);
      if (e.hidden !== null) hidden = e.hidden;
      if (e.drop !== null && e.drop.reason.trim() !== "") drop = e.drop.reason.trim();
    }
    const closed = closures.some((c) => aliases.has(c.threadId));
    const status: Thread["status"] = drop !== null ? "dropped" : closed ? "closed" : lifecycleStatus(entries, todayWeek);

    threads.push({
      id,
      title,
      keys,
      weeks: entries,
      firstWeek: entries[0]!.week,
      lastWeek: entries[entries.length - 1]!.week,
      status,
      droppedReason: drop,
      links,
      hidden,
    });
  }
  threads.sort((a, b) => a.firstWeek.localeCompare(b.firstWeek) || a.id.localeCompare(b.id));
  return { threads, aliasToId };
}

export const buildThreads = (weeks: readonly ThreadWeekInput[], edits: readonly ThreadEdit[], closures: readonly ClosureNote[], todayWeek: string): Thread[] =>
  buildThreadsDetailed(weeks, edits, closures, todayWeek).threads;

/** A thread that shipped within this many weeks of today can still be asked for a closure note. */
export const CLOSURE_RECENT_WEEKS = 4;
/** A thread is substantial when it spans at least this many distinct weeks. */
export const CLOSURE_MIN_WEEKS = 2;
const STABLE_KEY = /^(jira|pr|doc):/;

/** The week a thread last shipped in, or null. */
export const lastShippedWeek = (t: Thread): string | null => [...t.weeks].reverse().find((e) => e.state === "shipped")?.week ?? null;

/**
 * Worth a closure note: substantial (spans 2+ weeks, or has a stable key with in-progress history) AND shipped within
 * the last 4 weeks. A one-week "shipped" claim from months ago is still `shipped`, but never prompts.
 */
export function wantsClosureNote(t: Thread, todayWeek: string): boolean {
  if (t.status !== "shipped" || t.hidden) return false;
  const shipped = lastShippedWeek(t);
  if (shipped === null || weeksBetween(shipped, todayWeek) > CLOSURE_RECENT_WEEKS) return false;
  const spans = new Set(t.weeks.map((e) => e.week)).size >= CLOSURE_MIN_WEEKS;
  const keyed = t.keys.some((k) => STABLE_KEY.test(k)) && t.weeks.some((e) => e.state === "in_progress");
  return spans || keyed;
}

/** Ids of threads that should be prompted for a closure note. */
export const needClosureIds = (threads: readonly Thread[], todayWeek: string): string[] => threads.filter((t) => wantsClosureNote(t, todayWeek)).map((t) => t.id);

/** Older work the Threads tab hides by default: not active or at risk, and last touched over 4 weeks ago. */
export const isOlderThread = (t: Thread, todayWeek: string): boolean => t.status !== "active" && t.status !== "at_risk" && weeksBetween(t.lastWeek, todayWeek) > CLOSURE_RECENT_WEEKS;
