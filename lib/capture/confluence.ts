/**
 * confluence.ts — Confluence docs the user wrote or edited, for a date range, read by a read-only agent thread with
 * whatever wiki read tools the user's agent has connected. The plugin holds no credentials.
 *
 * CQL `lastmodified` is only a page's LATEST edit, so a page edited in August and again in September would land on
 * the September date. The prompt therefore asks the agent to date each of the user's edits from the page's version
 * history. Comments are dated by their own creation time.
 */
import type { Job, Runner } from "../engine/runner";
import { withIdentity } from "./identity";
import { MAX_EVIDENCE_PER_SOURCE, MAX_WHAT, clip, type RawEntry, type SourcePart, type Identity } from "../types";
import { CAPTURE_RULES, coverageOf, datesIn, httpsLink, isRec, optString, type DateRange } from "./common";
import { kindsFor } from "./sources";

export interface ConfluenceActivitySource {
  kind: "rest" | "agent";
  fetch(range: DateRange): Promise<Record<string, SourcePart>>;
}

export interface ConfluenceJobOptions {
  /** Who the user is; adds a line to the prompt so transcripts and handles are credited to them. */
  identity?: Identity | undefined;
  timeZone: string;
}

const dayBefore = (date: string): string => new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** `opts.identity` adds who the user is to the prompt (see identity.ts). */
export function confluenceActivityJob(range: DateRange, opts: ConfluenceJobOptions): Job<Record<string, SourcePart>> {
  return withIdentity(confluenceActivityJobBase(range, opts), opts.identity);
}

function confluenceActivityJobBase(range: DateRange, opts: ConfluenceJobOptions): Job<Record<string, SourcePart>> {
  return {
    kind: "worklog-confluence",
    prompt: `You are a read-only data fetcher for a personal work log. Use ONLY the wiki read tools (e.g. Confluence CQL search, page reads, page history). Never create, edit or comment on anything.

List the signed-in user's OWN Confluence activity from ${range.from} to ${range.to} inclusive (${opts.timeZone} dates):
- "doc_created": pages or blog posts they created in the range.
- "doc_edited": pages they edited in the range (one entry per page per day; say how many edits).
- "doc_commented": comments they wrote (one entry per page per day).
Find candidates with CQL such as contributor = currentUser() AND lastmodified >= "${dayBefore(range.from)}" AND type in (page, blogpost). A page's lastmodified is only its latest edit, so date each edit from the page's version history and keep only versions they authored. Ignore other people's edits.

${CAPTURE_RULES}

Reply format:
\`\`\`json
{"available":true,"note":null,"entries":[{"date":"${range.from}","kind":"doc_edited","title":"ADR: API gateway","url":"https://example.atlassian.net/wiki/spaces/ENG/pages/1","detail":"3 edits"}]}
\`\`\``,
    validate: (data) => validateConfluenceActivity(data, range),
  };
}

export function validateConfluenceActivity(data: unknown, range: DateRange): Record<string, SourcePart> {
  if (!isRec(data)) throw new Error("confluence reply is not an object");
  const coverage = coverageOf(data, "confluence");
  const dates = datesIn(range);
  if (coverage.status === "failed") return Object.fromEntries(dates.map((d) => [d, { coverage, entries: [] as RawEntry[] }]));
  if (!Array.isArray(data.entries)) throw new Error("entries array missing");
  const kinds = kindsFor("confluence");
  const byDate = new Map<string, RawEntry[]>(dates.map((d) => [d, []]));
  for (const row of data.entries) {
    if (!isRec(row)) throw new Error("confluence entry is not an object");
    const kind = kinds.find((k) => k === row.kind);
    if (kind === undefined) throw new Error(`invalid confluence kind: ${JSON.stringify(row.kind)}`);
    const date = optString(row.date);
    if (date === null || !byDate.has(date)) throw new Error(`confluence entry date outside the range: ${JSON.stringify(row.date)}`);
    const title = optString(row.title);
    if (title === null) throw new Error("confluence entry has no title");
    const detail = optString(row.detail);
    const verb = kind === "doc_created" ? "Wrote" : kind === "doc_edited" ? "Edited" : "Commented on";
    byDate.get(date)!.push({ date, source: "confluence", kind, what: clip(`${verb} "${title}"${detail === null ? "" : ` (${detail})`}`, MAX_WHAT), link: httpsLink(row.url), outcome: null });
  }
  return Object.fromEntries([...byDate].map(([d, entries]) => [d, { coverage, entries: entries.slice(0, MAX_EVIDENCE_PER_SOURCE) }]));
}

export function createConfluenceAgentActivity(
  runner: Runner,
  model: () => string | undefined,
  opts: ConfluenceJobOptions & { timeoutMs?: () => number },
): ConfluenceActivitySource {
  return {
    kind: "agent",
    fetch: (range) => runner.runJob(confluenceActivityJob(range, opts), { model: model(), timeoutMs: (opts.timeoutMs ?? (() => 10 * 60_000))(), retryOnWorkerError: false }),
  };
}
