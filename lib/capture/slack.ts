/** slack.ts — one day of chat activity (Slack), fetched by a read-only worker. */
import type { Job } from "../engine/runner";
import { withIdentity } from "./identity";
import { MAX_EVIDENCE_PER_SOURCE, MAX_OUTCOME, MAX_WHAT, clip, type Coverage, type RawEntry, type Identity } from "../types";
import { CAPTURE_RULES, coverageOf, httpsLink, isRec, optString } from "./common";
import { kindsFor } from "./sources";

export interface SlackCapture {
  coverage: Coverage;
  entries: RawEntry[];
}

export interface SlackOptions {
  /** Who the user is; adds a line to the prompt so transcripts and handles are credited to them. */
  identity?: Identity | undefined;
  timeZone: string;
  /** Channels whose posts count as evidence on their own. Empty = no such list item in the prompt. */
  watchedChannels: readonly string[];
}

/** A channel name from settings: letters, digits, dot, underscore, hyphen. Anything else is dropped, never put in a prompt. */
export const CHANNEL_RE = /^[A-Za-z0-9._-]{1,80}$/;

/** `opts.identity` adds who the user is to the prompt (see identity.ts). */
export function worklogSlackJob(date: string, opts: SlackOptions): Job<SlackCapture> {
  return withIdentity(worklogSlackJobBase(date, opts), opts.identity);
}

function worklogSlackJobBase(date: string, opts: SlackOptions): Job<SlackCapture> {
  const watched = opts.watchedChannels.map((c) => c.trim().replace(/^#/, "")).filter((c) => CHANNEL_RE.test(c)).map((c) => JSON.stringify(`#${c}`));
  const items = [
    `threads the user STARTED that day (kind "thread_started")`,
    `threads where the user posted 3 or more times that day (kind "thread_active", give "posts")`,
    `help the user gave ("help_given") or asked for ("help_asked")`,
    `kudos or recognition the user gave or received ("kudos")`,
    `decisions the user made or drove in a thread ("decision")`,
    ...(watched.length > 0 ? [`anything the user posted in these watched channels: ${watched.join(", ")} ("watched_channel")`] : []),
  ];
  return {
    kind: "worklog-slack",
    prompt: `You are a read-only data fetcher for a personal work log. Use ONLY the Slack read tools (search, read channel/thread history, permalinks). Never post, react, edit, mark as read or change anything.

Act as the signed-in Slack user. Window: ${date} 00:00-24:00 ${opts.timeZone}.
How to search: use the search tool that covers ALL channel types (public, private, group DMs and DMs; e.g. slack_search_public_and_private), never a public-only search. Search \`from:<@ME> on:${date}\` (ME = the signed-in user's id) sorted by timestamp and page through every result; then read the threads those messages belong to, and search \`to:<@ME> on:${date}\` for kudos and asks aimed at the user. Only report coverage as partial if a page or thread could not be read.
List:
${items.map((s, i) => `${i + 1}. ${s}${i === items.length - 1 ? "." : ";"}`).join("\n")}
One item per thread (pick the strongest kind). Skip bots and trivial reactions. At most ${MAX_EVIDENCE_PER_SOURCE} items. "what" says what the user did in at most ${MAX_WHAT} characters; "outcome" is the visible result or null.

${CAPTURE_RULES}

Reply format:
\`\`\`json
{"available":true,"note":null,"items":[{"kind":"help_given","channel":"eng-help","what":"...","outcome":"...","url":"https://example.slack.com/archives/C1/p1","ts":"1699999999.000100","posts":4}]}
\`\`\``,
    validate: (data) => validateSlackActivity(data, date),
  };
}

export function validateSlackActivity(data: unknown, date: string): SlackCapture {
  if (!isRec(data)) throw new Error("slack reply is not an object");
  const coverage = coverageOf(data, "slack");
  if (coverage.status === "failed") return { coverage, entries: [] };
  if (!Array.isArray(data.items)) throw new Error("items array missing");
  const kinds = kindsFor("slack");
  const seen = new Set<string>();
  const entries: RawEntry[] = [];
  for (const row of data.items) {
    if (!isRec(row)) throw new Error("slack item is not an object");
    const kind = kinds.find((k) => k === row.kind);
    if (kind === undefined) throw new Error(`invalid slack kind: ${JSON.stringify(row.kind)}`);
    const what = optString(row.what);
    if (what === null) throw new Error("slack item has no text");
    const link = httpsLink(row.url);
    if (link === null) throw new Error(`invalid slack url for "${clip(what, 40)}"`);
    if (seen.has(link)) continue;
    seen.add(link);
    const channel = optString(row.channel)?.replace(/^#/, "") ?? null;
    const outcome = optString(row.outcome);
    entries.push({
      date,
      source: "slack",
      kind,
      what: clip(channel === null ? what : `#${channel}: ${what}`, MAX_WHAT),
      link,
      outcome: outcome === null ? null : clip(outcome, MAX_OUTCOME),
    });
  }
  return { coverage, entries: entries.slice(0, MAX_EVIDENCE_PER_SOURCE) };
}
