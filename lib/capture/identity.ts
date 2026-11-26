/**
 * identity.ts — who "the user" is, as a line in every capture prompt. Meeting transcripts and notes name speakers, and
 * chat and trackers use handles, so the agent needs the name, email and handles to credit the right lines to the user.
 * Text is user-supplied: single line, no fence-like or markup characters, clipped.
 */
import type { Job } from "../engine/runner";
import type { Identity } from "../types";

const clean = (text: string, max: number): string =>
  text.replace(/\s+/g, " ").replace(/[<>`"\\]/g, "").trim().slice(0, max);

const HANDLE_LABEL: Record<string, (value: string) => string> = {
  slack: (v) => `Slack ${v}`,
  github: (v) => `GitHub @${v.replace(/^@/, "")}`,
  jira: (v) => `Jira ${v}`,
};

const HANDLE_ORDER = ["slack", "github", "jira"];

/** The identity paragraph, or "" when there is no usable name. */
export function identityLine(identity: Identity | undefined): string {
  if (identity === undefined) return "";
  const name = clean(identity.name, 80);
  if (name === "") return "";
  const parts: string[] = [];
  const email = identity.email === null ? "" : clean(identity.email, 120);
  if (email !== "") parts.push(email);
  const rank = (k: string) => {
    const at = HANDLE_ORDER.indexOf(k.toLowerCase());
    return at === -1 ? HANDLE_ORDER.length : at;
  };
  for (const [key, raw] of Object.entries(identity.handles).sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))) {
    const value = clean(raw, 80);
    const k = clean(key, 20);
    if (value === "" || k === "") continue;
    parts.push((HANDLE_LABEL[k.toLowerCase()] ?? ((v: string) => `${k} ${v}`))(value));
  }
  return `The user is ${name}${parts.length > 0 ? ` (${parts.join("; ")})` : ""}. In meeting transcripts and notes, their lines are attributed to this name or email.`;
}

/** Inserts the identity paragraph after the prompt's first paragraph (or appends it); a job without identity is unchanged. */
export function withIdentity<T>(job: Job<T>, identity: Identity | undefined): Job<T> {
  const line = identityLine(identity);
  if (line === "") return job;
  const at = job.prompt.indexOf("\n\n");
  const prompt = at === -1 ? `${job.prompt}\n\n${line}` : `${job.prompt.slice(0, at)}\n\n${line}${job.prompt.slice(at)}`;
  return { ...job, prompt };
}
