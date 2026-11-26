/**
 * context.ts — the user's notes vault and agent memory for a date range, fetched by one read-only worker.
 * Vault: dated entries in project notes (logs, context, tasks) and notes last written in the range. Memory:
 * decisions, outcomes and task completions whose created_at falls in the range (a memory service may have no date
 * filter, so the worker searches by date and topic and the validator drops anything outside the range).
 * A part the user excluded is never asked about and yields `off` coverage for each date.
 */
import type { Job } from "../engine/runner";
import { withIdentity } from "./identity";
import { MAX_EVIDENCE_PER_SOURCE, MAX_WHAT, clip, type RawEntry, type SourcePart, type Identity } from "../types";
import { CAPTURE_RULES, OFF, coverageOf, datesIn, isRec, optString, type DateRange } from "./common";
import { kindsFor } from "./sources";

export interface ContextCapture {
  vault: Record<string, SourcePart>;
  memory: Record<string, SourcePart>;
}

export interface ContextOptions {
  /** Who the user is; adds a line to the prompt so transcripts and handles are credited to them. */
  identity?: Identity | undefined;
  timeZone: string;
  /** Vault folders to ignore entirely (e.g. generated folders that would double-count other sources). */
  skipFolders: readonly string[];
  includeVault: boolean;
  includeMemory: boolean;
}
/** What the validator needs: the same options minus the zone. Both flags default to true, skipFolders to none. */
export type ContextValidateOptions = Partial<Omit<ContextOptions, "timeZone" | "identity">>;

const MEMORY_KIND: Record<string, string> = {
  decision: "decision",
  outcome: "outcome",
  completion: "outcome",
  task: "task",
  loop: "task",
  fact: "context",
  summary: "context",
  context: "context",
};

const normFolder = (f: string): string => f.trim().replace(/^\/+|\/+$/g, "");
/** A skip-folder from settings: no control characters, quotes or backticks, at most 200 characters. Anything else is dropped. */
export const safeFolder = (f: string): boolean => f !== "" && f.length <= 200 && !/[\u0000-\u001f\u007f"'`\\]/.test(f);
const inFolder = (path: string, folder: string): boolean => folder !== "" && (path === folder || path.startsWith(`${folder}/`));

/** `opts.identity` adds who the user is to the prompt (see identity.ts). */
export function worklogContextJob(range: DateRange, opts: ContextOptions): Job<ContextCapture> {
  return withIdentity(worklogContextJobBase(range, opts), opts.identity);
}

function worklogContextJobBase(range: DateRange, opts: ContextOptions): Job<ContextCapture> {
  const dates = datesIn(range);
  const skip = opts.skipFolders.map(normFolder).filter(safeFolder);
  const steps: string[] = [];
  const sections: string[] = [];
  const tools: string[] = [];
  if (opts.includeVault) {
    tools.push("the user's notes vault read tools");
    steps.push(`Notes vault (the user's notes vault tools, e.g. search_notes, list_notes, read_note).${skip.length > 0 ? ` Skip these folders entirely: ${skip.map((f) => JSON.stringify(f)).join(", ")}.` : ""}
   Date every entry by when the record was written, never by when you read it:
   a. Dated headings and lines: for each date, search the vault for the literal date (e.g. "${range.from}"); project log notes often use headings like "### ${range.from}". Read the section under each matching heading and keep what the user did or decided: kind "log_entry", dated by the heading.
   b. New docs: a frontmatter \`created: <date>\` in the window means the note was written that day: kind "note_written", dated by created (one line on what it is about).
   c. Only for notes with neither a dated heading nor a created date: list notes and use the note's modified date if it is in the window (kind "note_written"); a later edit hides earlier ones, so say "last edited" in "what".`);
    sections.push(`"vault":{"available":true,"note":null,"entries":[{"date":"${range.from}","kind":"log_entry","path":"projects/gateway/Log.md","what":"..."}]}`);
  }
  if (opts.includeMemory) {
    tools.push("the agent memory read tools");
    steps.push(`Memory (the agent memory tools, e.g. a long-term memory search). Search once per date with a query naming that date, and once for the window with "decisions and outcomes ${range.from} to ${range.to}". Keep only results whose created_at falls on a date in the window (convert to ${opts.timeZone}). Skip records that say there was no activity. kind: the memory type mapped decision->"decision", outcome or completion->"outcome", task or loop->"task", anything else->"context".`);
    sections.push(`"memory":{"available":true,"note":null,"entries":[{"date":"${range.from}","kind":"decision","project":"gateway","what":"..."}]}`);
  }

  const prompt =
    steps.length === 0
      ? `Nothing to fetch for ${range.from} to ${range.to}: both the notes vault and agent memory are excluded. Reply with {}.`
      : `You are a read-only data fetcher for a personal work log. Use ONLY ${tools.join(" and ")}. Never write, append, delete or log anything.

Window: ${range.from} to ${range.to} inclusive (${opts.timeZone}). Dates: ${dates.join(", ")}.

${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}
One entry per fact; merge duplicates${opts.includeMemory ? " (memory often stores the same item twice)" : ""}. At most ${MAX_EVIDENCE_PER_SOURCE} entries per source per date. "what" says what the user did or decided, in at most ${MAX_WHAT} characters.

${CAPTURE_RULES}

Reply format:
\`\`\`json
{${sections.join(",\n ")}}
\`\`\``;

  return { kind: "worklog-context", prompt, validate: (data) => validateContextReply(data, range, opts) };
}

function part(section: unknown, label: "vault" | "memory", range: DateRange, skip: readonly string[]): Record<string, SourcePart> {
  const dates = datesIn(range);
  const coverage = coverageOf(section, label);
  if (coverage.status === "failed") return Object.fromEntries(dates.map((d) => [d, { coverage, entries: [] }]));
  const rec = section as Record<string, unknown>;
  if (!Array.isArray(rec.entries)) throw new Error(`${label}.entries array missing`);
  const vaultKinds = kindsFor("vault");
  const byDate = new Map<string, RawEntry[]>(dates.map((d) => [d, []]));
  const seen = new Set<string>();
  for (const row of rec.entries) {
    if (!isRec(row)) throw new Error(`${label} entry is not an object`);
    const date = optString(row.date);
    // The memory service may not filter by date, so out-of-range rows are expected: drop them, do not fail.
    if (date === null || !byDate.has(date)) continue;
    const raw = optString(row.kind) ?? "";
    const kind = label === "vault" ? vaultKinds.find((k) => k === raw) : MEMORY_KIND[raw];
    if (kind === undefined) throw new Error(`invalid ${label} kind: ${JSON.stringify(row.kind)}`);
    const what = optString(row.what);
    if (what === null) throw new Error(`${label} entry has no text`);
    const where = label === "vault" ? optString(row.path) : optString(row.project);
    if (label === "vault" && where !== null && skip.some((f) => inFolder(where.replace(/^\/+/, ""), f))) continue;
    const text = clip(where === null ? what : `${label === "vault" ? where.replace(/\.md$/, "") : `[${where}]`}: ${what}`, MAX_WHAT);
    const key = `${date}|${text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    byDate.get(date)!.push({ date, source: label, kind, what: text, link: null, outcome: null });
  }
  return Object.fromEntries([...byDate].map(([d, entries]) => [d, { coverage, entries: entries.slice(0, MAX_EVIDENCE_PER_SOURCE) }]));
}

const offPart = (range: DateRange): Record<string, SourcePart> => Object.fromEntries(datesIn(range).map((d) => [d, { coverage: OFF(), entries: [] }]));

export function validateContextReply(data: unknown, range: DateRange, opts: ContextValidateOptions = {}): ContextCapture {
  const includeVault = opts.includeVault ?? true;
  const includeMemory = opts.includeMemory ?? true;
  const skip = (opts.skipFolders ?? []).map(normFolder).filter((f) => f !== "");
  if (!includeVault && !includeMemory) return { vault: offPart(range), memory: offPart(range) };
  if (!isRec(data)) throw new Error("context reply is not an object");
  return {
    vault: includeVault ? part(data.vault, "vault", range, skip) : offPart(range),
    memory: includeMemory ? part(data.memory, "memory", range, skip) : offPart(range),
  };
}
