// UI-side source labels and the connector status wording. Duplicates the ids/labels in lib/capture/sources.ts on purpose:
// that module imports zod, which must stay out of the frontend bundle.
import type { ConnectorCheck } from "../../lib/types";

export const SOURCE_ORDER = ["calendar", "granola", "fellow", "jira", "confluence", "github", "slack", "vault", "memory"] as const;
export const SOURCE_LABEL: Record<string, string> = {
  calendar: "Calendar",
  granola: "Meeting notes (Granola)",
  fellow: "Meeting notes (Fellow)",
  jira: "Jira",
  confluence: "Confluence",
  github: "GitHub",
  slack: "Slack",
  vault: "Notes vault",
  memory: "Agent memory",
};

export type ConnectorStatus = "found" | "partial" | "missing" | "unchecked";
export type ConnectorStateLike = ConnectorCheck["sources"][string] | undefined;

export function statusOf(state: ConnectorStateLike): ConnectorStatus {
  if (state === undefined || state.available === null) return "unchecked";
  if (!state.available) return "missing";
  return state.note !== null && state.note !== "" ? "partial" : "found";
}
export const STATUS_LABEL: Record<ConnectorStatus, string> = { found: "Found", partial: "Partial", missing: "Missing", unchecked: "Not checked" };
export const STATUS_ICON: Record<ConnectorStatus, string> = { found: "Check", partial: "TriangleAlert", missing: "X", unchecked: "Minus" };
export const STATUS_TONE: Record<ConnectorStatus, string> = {
  found: "bg-green-700/15 text-green-800 dark:text-green-300",
  partial: "bg-amber-500/20 text-amber-800 dark:text-amber-300",
  missing: "bg-muted text-muted-foreground",
  unchecked: "bg-muted text-muted-foreground",
};

/** True when a check exists and no source is reachable: nothing could be rated. */
export const nothingConnected = (check: ConnectorCheck | null): boolean =>
  check !== null && Object.values(check.sources).every((s) => s.available !== true);
