/**
 * jira.ts — Jira activity for a date range. The plugin holds no credentials: a read-only agent thread uses whatever
 * issue-tracker read tools the user's agent has connected. Only the user's own actions count: issues they created,
 * status changes they made (resolved when the change resolved the issue), issues resolved while assigned to them,
 * and comments they wrote.
 */
import { ISSUE_KEY_RE } from "../engine/json";
import type { Job, Runner } from "../engine/runner";
import { withIdentity } from "./identity";
import { MAX_EVIDENCE_PER_SOURCE, MAX_WHAT, clip, type RawEntry, type SourcePart, type Identity } from "../types";
import { CAPTURE_RULES, coverageOf, datesIn, httpsLink, isRec, optString, type DateRange } from "./common";
import { kindsFor } from "./sources";

/** Kept as an alias so callers written against the original name still fit. */
export type JiraRange = DateRange;

export interface JiraActivitySource {
  kind: "rest" | "agent";
  fetch(range: DateRange): Promise<Record<string, SourcePart>>;
}

export interface JiraJobOptions {
  /** Who the user is; adds a line to the prompt so transcripts and handles are credited to them. */
  identity?: Identity | undefined;
  timeZone: string;
  /** Optional base URL (https://yourco.atlassian.net). Only used to build links for entries whose tool result carried no url. */
  siteUrl?: string | undefined;
}

const dayBefore = (date: string): string => new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** `opts.identity` adds who the user is to the prompt (see identity.ts). */
export function jiraActivityJob(range: DateRange, opts: JiraJobOptions): Job<Record<string, SourcePart>> {
  return withIdentity(jiraActivityJobBase(range, opts), opts.identity);
}

function jiraActivityJobBase(range: DateRange, opts: JiraJobOptions): Job<Record<string, SourcePart>> {
  return {
    kind: "worklog-jira",
    prompt: `You are a read-only data fetcher for a personal work log. Use ONLY the issue-tracker read tools (e.g. Jira JQL search, issue reads with changelog and comments). Never create, edit, transition or comment on anything.

List the signed-in user's OWN Jira activity from ${range.from} to ${range.to} inclusive (${opts.timeZone} dates), as one entry per event:
- "created": issues they created.
- "transitioned": status changes they made (detail "From -> To").
- "resolved": status changes they made that resolved the issue, or issues resolved while assigned to them.
- "commented": comments they wrote (one entry per issue per day; detail is the first 160 characters).
Use JQL such as updated >= "${dayBefore(range.from)}" AND (assignee = currentUser() OR reporter = currentUser() OR status CHANGED BY currentUser()) then read each candidate's changelog and comments. Ignore other people's actions.
Include the issue's browse URL as "url" when the tool returns one.

${CAPTURE_RULES}

Reply format:
\`\`\`json
{"available":true,"note":null,"entries":[{"date":"${range.from}","kind":"resolved","key":"ACME-12","summary":"Rate limit the gateway","detail":"In Review -> Done","url":"https://example.atlassian.net/browse/ACME-12"}]}
\`\`\``,
    validate: (data) => validateJiraActivity(data, range, opts.siteUrl),
  };
}

export function validateJiraActivity(data: unknown, range: DateRange, siteUrl?: string): Record<string, SourcePart> {
  if (!isRec(data)) throw new Error("jira reply is not an object");
  const coverage = coverageOf(data, "jira");
  const dates = datesIn(range);
  if (coverage.status === "failed") return Object.fromEntries(dates.map((d) => [d, { coverage, entries: [] as RawEntry[] }]));
  if (!Array.isArray(data.entries)) throw new Error("entries array missing");
  const base = (siteUrl ?? "").trim().replace(/\/+$/, "");
  const kinds = kindsFor("jira");
  const byDate = new Map<string, RawEntry[]>(dates.map((d) => [d, []]));
  for (const row of data.entries) {
    if (!isRec(row)) throw new Error("jira entry is not an object");
    const key = optString(row.key);
    if (key === null || !ISSUE_KEY_RE.test(key)) throw new Error(`invalid jira key: ${JSON.stringify(row.key)}`);
    const kind = kinds.find((k) => k === row.kind);
    if (kind === undefined) throw new Error(`invalid jira kind: ${JSON.stringify(row.kind)}`);
    const date = optString(row.date);
    if (date === null || !byDate.has(date)) throw new Error(`jira entry date outside the range: ${JSON.stringify(row.date)}`);
    const summary = optString(row.summary) ?? "";
    const detail = optString(row.detail);
    byDate.get(date)!.push({
      date,
      source: "jira",
      kind,
      what: clip(`${key} ${summary}`.trim() + (detail === null ? "" : `: ${detail}`), MAX_WHAT),
      link: httpsLink(row.url) ?? (/^https:\/\/\S+$/.test(base) ? `${base}/browse/${key}` : null),
      outcome: null,
    });
  }
  return Object.fromEntries([...byDate].map(([d, entries]) => [d, { coverage, entries: entries.slice(0, MAX_EVIDENCE_PER_SOURCE) }]));
}

export function createJiraAgentActivity(
  runner: Runner,
  model: () => string | undefined,
  opts: JiraJobOptions & { timeoutMs?: () => number },
): JiraActivitySource {
  return {
    kind: "agent",
    fetch: (range) => runner.runJob(jiraActivityJob(range, opts), { model: model(), timeoutMs: (opts.timeoutMs ?? (() => 10 * 60_000))(), retryOnWorkerError: false }),
  };
}
