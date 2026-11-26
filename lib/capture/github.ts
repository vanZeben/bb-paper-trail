/**
 * github.ts — GitHub activity for a date range, two ways:
 *  - gh-script mode: a worker runs ONE read-only shell script of small, separate `gh api graphql` calls (GitHub answers
 *    big combined documents with 502) under the capture host's own `gh` login and relays its compact JSON;
 *    `mapGithubActivity` buckets it per local day deterministically.
 *  - MCP mode: a worker uses the GitHub read tools the user's agent has connected (`githubMcpJob`); the reply is
 *    validated into the same per-day parts with the same kinds.
 * The plugin holds no credentials in either mode.
 */
import { dayBounds, gitHubInstant } from "../engine/dates";
import type { Job } from "../engine/runner";
import { withIdentity } from "./identity";
import { localParts } from "../engine/time";
import { PLUGIN_ID } from "../meta";
import { MAX_EVIDENCE_PER_SOURCE, MAX_OUTCOME, MAX_WHAT, clip, type RawEntry, type Identity, type SourcePart } from "../types";
import { CAPTURE_RULES, coverageOf, datesIn, isRec, optString, type DateRange } from "./common";
import { kindsFor } from "./sources";

const ORG_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DAY = 86_400_000;
const SUBSTANTIVE_BODY = 80;

/** Neutral label for the script's error prefix, temp file and heredoc delimiter, built from the plugin id. */
const GH_LABEL = `${PLUGIN_ID}-gh`;
const GH_FILE = `/tmp/${GH_LABEL}.sh`;
const GH_EOF = `${PLUGIN_ID.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_SCRIPT_EOF`;

/** Replaces READ_ONLY_GUARD for the gh-script job: exactly one named read-only script is allowed. */
export const GH_SCRIPT_GUARD = `You are a background data worker for a personal work-log plugin. You may only READ. Exactly ONE shell script is allowed for this task: the read-only script given below (write it to the named temp file with the quoted heredoc, then run it once with sh). The script only makes read-only \`gh api graphql\` queries. Everything else stays forbidden: no other shell commands, no other tools, no per-PR lookups, no file edits, and never create, edit, merge, review, comment on, label, send or delete anything in any system.`;

const PR_OPEN_FIELDS = `number title createdAt mergedAt additions deletions repository{nameWithOwner}`;
const search = (alias: string, q: string, first: number, fields: string, vars = "") =>
  `query${vars}{${alias}: search(query:"${q}", type:ISSUE, first:${first}){issueCount nodes{... on PullRequest{${fields}}}}}`;

/** ` org:<org>` when an org is set, otherwise nothing (search then covers every repo the login can see). */
function orgQualifier(org: string): string {
  if (org === "") return "";
  if (!ORG_RE.test(org)) throw new Error(`invalid GitHub org: ${JSON.stringify(org)}`);
  return ` org:${org}`;
}

export function buildWorklogGhQueries({ org, start, end, includePending }: { org: string; start: string; end: string; includePending: boolean }) {
  const o = orgQualifier(org);
  if (!INSTANT_RE.test(start) || !INSTANT_RE.test(end)) throw new Error("start/end must be UTC instants YYYY-MM-DDTHH:MM:SSZ");
  return {
    viewer: "query{viewer{login}}",
    opened: search("opened", `is:pr author:@me${o} created:${start}..${end}`, 50, PR_OPEN_FIELDS),
    merged: search("merged", `is:pr author:@me${o} merged:${start}..${end}`, 50, PR_OPEN_FIELDS),
    reviewed: search(
      "reviewed",
      // A review in [start, end] needs a PR created by `end` and updated at or after `start` (the review itself
      // updates it). No upper bound on `updated`: PRs that moved on after the window are still counted.
      `is:pr reviewed-by:@me -author:@me${o} created:<=${end} updated:>=${start} sort:created-desc`,
      100,
      `number title additions deletions author{login} repository{nameWithOwner} reviews(author:$login, first:20){nodes{state submittedAt body comments{totalCount}}}`,
      "($login:String!)",
    ),
    pending: includePending ? search("pending", `is:pr is:open draft:false review-requested:@me${o}`, 40, `number title createdAt author{login} repository{nameWithOwner}`) : null,
  };
}
/** POSIX sh script: separate read-only `gh api graphql` calls, then one compact JSON object on stdout. */
export function buildWorklogGhScript(input: { org: string; start: string; end: string; includePending: boolean }): string {
  const q = buildWorklogGhQueries(input);
  const call = (name: string, file: string, query: string, extra = "") =>
    `gh api graphql ${extra}-f query='${query}' >"$D/${file}.json" 2>"$D/err" && jq -e '.data' "$D/${file}.json" >/dev/null 2>&1 || fail "${name}"`;
  const open = `[.repository.nameWithOwner, .number, t, .createdAt, .mergedAt, .additions, .deletions]`;
  const filter = `def t: (.title // "")[0:90];
$v[0].data.viewer.login as $me
| {login: $me,
   openedCount: $o[0].data.opened.issueCount,
   mergedCount: $m[0].data.merged.issueCount,
   reviewedCount: $r[0].data.reviewed.issueCount,
   opened: [$o[0].data.opened.nodes[] | select(.number) | ${open}],
   merged: [$m[0].data.merged.nodes[] | select(.number) | ${open}],
   reviewed: [$r[0].data.reviewed.nodes[] | select(.number) | [.repository.nameWithOwner, .number, t, (.author.login // null), .additions, .deletions, [.reviews.nodes[]? | [.state, .submittedAt, ((.body // "") | length), (.comments.totalCount // 0)]]]],
   pendingCount: ${q.pending === null ? "null" : "$p[0].data.pending.issueCount"},
   pending: ${q.pending === null ? "null" : `[$p[0].data.pending.nodes[] | select(.number) | [.repository.nameWithOwner, .number, t, .createdAt, (.author.login // null)]]`}}`;
  const slurps = `--slurpfile v "$D/v.json" --slurpfile o "$D/o.json" --slurpfile m "$D/m.json" --slurpfile r "$D/r.json"${q.pending === null ? "" : ` --slurpfile p "$D/p.json"`}`;
  return `#!/bin/sh
# Work log GitHub fetch: read-only GraphQL queries, compact JSON out.
D=$(mktemp -d) || exit 1
trap 'rm -rf "$D"' EXIT
fail() { echo "${GH_LABEL}: $1 query failed: $(head -c 300 "$D/err" 2>/dev/null | tr '\\n' ' ')" >&2; exit 1; }
${call("viewer", "v", q.viewer)}
ME=$(jq -r '.data.viewer.login' "$D/v.json")
${call("opened", "o", q.opened)}
${call("merged", "m", q.merged)}
${call("reviewed", "r", q.reviewed, `-f login="$ME" `)}
${q.pending === null ? "" : `${call("pending", "p", q.pending)}\n`}jq -c -n ${slurps} '${filter}' || { echo "${GH_LABEL}: jq failed" >&2; exit 1; }
`;
}

export function worklogGithubJob(range: DateRange, opts: { org: string; includePending: boolean; timeZone: string; now?: Date; /** Accepted for symmetry; the gh script uses the signed-in login, and its prompt must stay exactly the script. */ identity?: Identity | undefined }): Job<Record<string, SourcePart>> {
  const now = opts.now ?? new Date();
  const dates = datesIn(range);
  if (dates.length === 0) throw new Error("empty date range");
  const start = gitHubInstant(dayBounds(range.from, opts.timeZone).start);
  const end = gitHubInstant(new Date(dayBounds(range.to, opts.timeZone).end.getTime() - 1000));
  const script = buildWorklogGhScript({ org: opts.org, start, end, includePending: opts.includePending });
  return {
    kind: "worklog-github",
    guard: GH_SCRIPT_GUARD,
    prompt: `Run exactly this, once, and nothing else. First write the script to a temp file with a quoted heredoc, then run it:

cat > ${GH_FILE} <<'${GH_EOF}'
${script}${GH_EOF}
sh ${GH_FILE}

Reply with the script's stdout (one line of compact JSON) and nothing else: no prose, no summary, no markdown, no other tools, and do not rewrite, reorder, trim or "fix" any value. If the script exits non-zero, reply with exactly its error text and nothing else.`,
    validate: (reply) => mapGithubActivity(reply, { dates, now, timeZone: opts.timeZone }),
  };
}

// ─── mapping ─────────────────────────────────────────────────────────────

function cells(v: unknown, len: number, label: string): unknown[] {
  if (!Array.isArray(v) || v.length !== len) throw new Error(`${label} row must be an array of ${len}`);
  return v;
}
function list(v: unknown, label: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${label} must be an array`);
  return v;
}
function core(c: unknown[], label: string) {
  const [repo, number, title] = c;
  if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`invalid repo in ${label}: ${JSON.stringify(repo)}`);
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) throw new Error(`invalid PR number in ${label} for ${repo}`);
  if (typeof title !== "string") throw new Error(`invalid title in ${label} for ${repo}#${number}`);
  return { repo, number, title, ref: `${repo}#${number}`, url: `https://github.com/${repo}/pull/${number}` };
}
const login = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? `@${v.trim()}` : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const size = (c: unknown[], a: number, d: number) => `+${num(c[a])}/-${num(c[d])}`;
const STATE_WORD: Record<string, string> = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", COMMENTED: "commented", DISMISSED: "dismissed", PENDING: "pending" };

/** Bucket the script's compact object into per-local-day evidence (days in `timeZone`). */
export function mapGithubActivity(data: unknown, { dates, now, timeZone }: { dates: readonly string[]; now: Date; timeZone: string }): Record<string, SourcePart> {
  const dateOf = (v: unknown): string | null => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? localParts(new Date(v), timeZone).date : null);
  if (!isRec(data)) throw new Error("github data is not an object");
  if (typeof data.login !== "string" || data.login === "") throw new Error("github data has no login");
  const wanted = new Set(dates);
  const lastDate = [...dates].sort().at(-1)!;
  const byDate: Record<string, RawEntry[]> = Object.fromEntries(dates.map((d) => [d, [] as RawEntry[]]));
  const push = (date: string | null, entry: Omit<RawEntry, "date">) => {
    if (date !== null && wanted.has(date)) byDate[date]!.push({ ...entry, date, what: clip(entry.what, MAX_WHAT), outcome: entry.outcome === null ? null : clip(entry.outcome, MAX_OUTCOME) });
  };

  const opened = list(data.opened, "opened").map((r) => ({ c: cells(r, 7, "opened"), label: "opened" }));
  const merged = list(data.merged, "merged").map((r) => ({ c: cells(r, 7, "merged"), label: "merged" }));
  for (const { c } of opened) {
    const p = core(c, "opened");
    push(dateOf(c[3]), { source: "github", kind: "pr_opened", what: `Opened ${p.ref}: ${p.title} (${size(c, 5, 6)})`, link: p.url, outcome: null });
  }
  for (const { c } of merged) {
    const p = core(c, "merged");
    push(dateOf(c[4]), { source: "github", kind: "pr_merged", what: `Merged ${p.ref}: ${p.title} (${size(c, 5, 6)})`, link: p.url, outcome: null });
  }

  const reviewed = list(data.reviewed, "reviewed");
  for (const r of reviewed) {
    const c = cells(r, 7, "reviewed");
    const p = core(c, "reviewed");
    const perDate = new Map<string, Array<{ state: string; bodyLen: number; inline: number }>>();
    for (const rv of list(c[6], "reviewed.reviews")) {
      const [state, at, bodyLen, inline] = cells(rv, 4, "review");
      const date = dateOf(at);
      if (date === null || !wanted.has(date)) continue;
      perDate.set(date, [...(perDate.get(date) ?? []), { state: String(state), bodyLen: num(bodyLen), inline: num(inline) }]);
    }
    const author = login(c[3]);
    for (const [date, rvs] of perDate) {
      const substantive = rvs.some((x) => x.state === "CHANGES_REQUESTED" || x.bodyLen >= SUBSTANTIVE_BODY || x.inline >= 1);
      const states = [...new Set(rvs.map((x) => STATE_WORD[x.state] ?? x.state.toLowerCase()))].join(", ");
      const inline = rvs.reduce((s, x) => s + x.inline, 0);
      push(date, {
        source: "github",
        kind: substantive ? "review" : "review_light",
        what: `Reviewed ${p.ref}${author === null ? "" : ` by ${author}`}: ${p.title} (${size(c, 4, 5)}): ${states}${inline > 0 ? `, ${inline} inline comment${inline === 1 ? "" : "s"}` : ""}`,
        link: p.url,
        outcome: null,
      });
    }
  }

  let pendingIncluded = false;
  if (data.pending !== null && data.pending !== undefined) {
    pendingIncluded = true;
    for (const r of list(data.pending, "pending")) {
      const c = cells(r, 5, "pending");
      const p = core(c, "pending");
      const created = typeof c[3] === "string" ? Date.parse(c[3]) : Number.NaN;
      const days = Number.isNaN(created) ? null : Math.max(0, Math.floor((now.getTime() - created) / DAY));
      const author = login(c[4]);
      push(lastDate, {
        source: "github",
        kind: "review_pending",
        what: `Review requested ${p.ref}${author === null ? "" : ` by ${author}`}: ${p.title}`,
        link: p.url,
        outcome: days === null ? "requested, not reviewed" : `requested ${days} day${days === 1 ? "" : "s"} ago, not reviewed`,
      });
    }
  }

  const truncated: string[] = [];
  const check = (label: string, total: unknown, rows: unknown[]) => {
    if (typeof total === "number" && total > rows.length) truncated.push(`${label} ${total} found, ${rows.length} read`);
  };
  check("opened", data.openedCount, opened);
  check("merged", data.mergedCount, merged);
  check("reviewed", data.reviewedCount, reviewed);
  if (pendingIncluded) check("review requests", data.pendingCount, data.pending as unknown[]);

  const notes: string[] = [];
  if (truncated.length > 0) notes.push(`more results than fetched (${truncated.join("; ")})`);
  if (!pendingIncluded) notes.push("review requests not acted on cannot be reconstructed for past dates");
  const coverage = notes.length > 0 ? ({ status: "partial", note: notes.join("; ") } as const) : ({ status: "ok", note: null } as const);

  return Object.fromEntries(dates.map((d) => [d, { coverage, entries: byDate[d]! }]));
}

// ─── MCP mode ────────────────────────────────────────────────────────────

/** Mode 2: the agent's own GitHub read tools. Same per-day parts and kinds as the gh-script mode. */
/** `opts.identity` adds who the user is to the prompt (see identity.ts). */
export function githubMcpJob(range: DateRange, opts: { timeZone: string; org: string; identity?: Identity | undefined }): Job<Record<string, SourcePart>> {
  return withIdentity(githubMcpJobBase(range, opts), opts.identity);
}

function githubMcpJobBase(range: DateRange, opts: { timeZone: string; org: string }): Job<Record<string, SourcePart>> {
  const org = opts.org.trim();
  if (org !== "" && !ORG_RE.test(org)) throw new Error(`invalid GitHub org: ${JSON.stringify(org)}`);
  const scope = org === "" ? "any repository the signed-in user can see" : `repositories in the ${JSON.stringify(org)} organization only`;
  return {
    kind: "worklog-github",
    prompt: `You are a read-only data fetcher for a personal work log. Use ONLY the code-host read tools (e.g. GitHub search for pull requests, get pull request, list pull request reviews and comments). Never create, edit, merge, review, comment on, label or close anything, and do not run shell commands.

List the signed-in user's OWN pull request activity from ${range.from} to ${range.to} inclusive (${opts.timeZone} dates), in ${scope}, as one entry per event:
- "pr_opened": pull requests they authored that were created in the range (date = creation date).
- "pr_merged": pull requests they authored that were merged in the range (date = merge date).
- "review": pull requests authored by someone else that they reviewed in the range, when the review was substantive: changes requested, a written review body of 80+ characters, or at least one inline comment (one entry per PR per day; date = review date).
- "review_light": the same, for a bare approval or a short comment (one entry per PR per day).
Search for authored pull requests with author:@me (or their login) and created:/merged: date qualifiers, and for reviewed ones with reviewed-by:@me -author:@me and an updated: qualifier, then read each candidate's reviews to get the dates and sizes. Use each date in ${opts.timeZone}, not UTC. Ignore other people's actions.

${CAPTURE_RULES}

Reply format (repo is owner/name; additions and deletions are the PR's totals, null when unknown; "author" is the PR author's login for reviews; "detail" for reviews is the review states and inline comment count, e.g. "approved, 3 inline comments"):
\`\`\`json
{"available":true,"note":null,"entries":[{"date":"${range.from}","kind":"pr_merged","repo":"acme/api","number":12,"title":"Add rate limiting","url":"https://github.com/acme/api/pull/12","additions":120,"deletions":10,"author":null,"detail":null}]}
\`\`\``,
    validate: (data) => validateGithubMcp(data, range, org),
  };
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const sizeOf = (row: Record<string, unknown>): string =>
  typeof row.additions === "number" && typeof row.deletions === "number" ? ` (+${row.additions}/-${row.deletions})` : "";

/** Map the MCP-mode reply into per-day parts; same kinds and `what` shapes as `mapGithubActivity`. */
export function validateGithubMcp(data: unknown, range: DateRange, org = ""): Record<string, SourcePart> {
  if (!isRec(data)) throw new Error("github reply is not an object");
  const coverage = coverageOf(data, "github");
  const dates = datesIn(range);
  if (coverage.status === "failed") return Object.fromEntries(dates.map((d) => [d, { coverage, entries: [] as RawEntry[] }]));
  if (!Array.isArray(data.entries)) throw new Error("entries array missing");
  const kinds = kindsFor("github");
  const orgLower = org.trim().toLowerCase();
  const byDate = new Map<string, RawEntry[]>(dates.map((d) => [d, []]));
  const seen = new Set<string>();
  for (const row of data.entries) {
    if (!isRec(row)) throw new Error("github entry is not an object");
    const kind = kinds.find((k) => k === row.kind);
    if (kind === undefined) throw new Error(`invalid github kind: ${JSON.stringify(row.kind)}`);
    const date = optString(row.date);
    // Search tools return edge rows (UTC vs local day, updated vs created); anything outside the range is dropped, not an error.
    if (date === null || !byDate.has(date)) continue;
    const repo = optString(row.repo);
    if (repo === null || !REPO_RE.test(repo)) throw new Error(`invalid repo: ${JSON.stringify(row.repo)}`);
    const number = row.number;
    if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) throw new Error(`invalid PR number for ${repo}`);
    if (orgLower !== "" && repo.split("/")[0]!.toLowerCase() !== orgLower) continue;
    const dedupe = `${date}|${kind}|${repo}#${number}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const ref = `${repo}#${number}`;
    const title = optString(row.title) ?? "";
    const author = login(row.author);
    const detail = optString(row.detail);
    const size = sizeOf(row);
    const link = `https://github.com/${repo}/pull/${number}`;
    let what: string;
    let outcome: string | null = null;
    if (kind === "pr_opened") what = `Opened ${ref}: ${title}${size}`;
    else if (kind === "pr_merged") what = `Merged ${ref}: ${title}${size}`;
    else if (kind === "review_pending") {
      what = `Review requested ${ref}${author === null ? "" : ` by ${author}`}: ${title}`;
      outcome = detail ?? "requested, not reviewed";
    } else what = `Reviewed ${ref}${author === null ? "" : ` by ${author}`}: ${title}${size}${detail === null ? "" : `: ${detail}`}`;
    byDate.get(date)!.push({ date, source: "github", kind, what: clip(what, MAX_WHAT), link, outcome: outcome === null ? null : clip(outcome, MAX_OUTCOME) });
  }
  return Object.fromEntries([...byDate].map(([d, entries]) => [d, { coverage, entries: entries.slice(0, MAX_EVIDENCE_PER_SOURCE) }]));
}
