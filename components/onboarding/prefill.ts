// Prefill the setup form from what the connector check found: the signed-in accounts per source. A value is only
// used when every account that looks like it agrees. Pure; type-only imports.
import type { ConnectorCheck } from "../../lib/types";

const EMAIL = /[^\s<>@"']+@[^\s<>@"']+\.[^\s<>@"']+/;
export const MAX_ROLE_CARD_CHARS = 20000;

export interface Prefill {
  name: string;
  email: string;
  handles: Record<string, string>;
}

const agreed = (values: string[]): string => {
  const keys = new Set(values.map((v) => v.trim().toLowerCase()));
  return keys.size === 1 ? values[0]!.trim() : "";
};

export function prefillIdentity(check: ConnectorCheck | null): Prefill {
  const none: Prefill = { name: "", email: "", handles: {} };
  if (check === null) return none;
  const names: string[] = [];
  const emails: string[] = [];
  const handles: Record<string, string> = {};
  for (const [source, state] of Object.entries(check.sources)) {
    const account = state.account?.trim();
    if (!account) continue;
    const email = EMAIL.exec(account)?.[0];
    if (email) emails.push(email);
    // "Alex Doe <alex@example.com>" carries a name too; a bare email or @handle does not.
    const label = account.replace(/<[^>]*>/g, "").trim();
    if (label !== "" && !label.startsWith("@") && !EMAIL.test(label) && !/^[UW][A-Z0-9]{6,}$/.test(label)) names.push(label);
    if (account.startsWith("@")) handles[source] = account.slice(1);
    else if (source === "slack" && /^[UW][A-Z0-9]{6,}$/.test(account)) handles[source] = account;
  }
  return { name: agreed(names), email: agreed(emails), handles };
}

/** Read-only summary line for the connector check while onboarding waits. */
export function connectedCount(check: ConnectorCheck | null): { found: number; total: number } {
  if (check === null) return { found: 0, total: 0 };
  const states = Object.values(check.sources);
  return { found: states.filter((s) => s.available === true).length, total: states.length };
}

/** Why a role card cannot be sent, or null when it is fine. */
export function roleCardProblem(kind: "text" | "note" | "url", value: string): string | null {
  const v = value.trim();
  if (v === "") return "Add your role card first.";
  if (kind === "text" && v.length > MAX_ROLE_CARD_CHARS) return `That is ${v.length.toLocaleString("en-US")} characters; the limit is ${MAX_ROLE_CARD_CHARS.toLocaleString("en-US")}. Trim it, or give a note path or link instead.`;
  if (kind === "url" && !/^https?:\/\/\S+$/.test(v)) return "A role card link must start with http:// or https://.";
  return null;
}
