/**
 * sources.ts — the source registry. v1 keeps the original nine ids and evidence-id prefixes so imported evidence ids
 * stay valid against EVIDENCE_ID_RE. Adding a source = one entry here + one capture job; stored days default the new
 * source to NOT_CAPTURED.
 */
import { SOURCE_IDS, type SourceId } from "../types";

export type SourceGroup = "calendar" | "meeting_notes" | "tracker" | "docs" | "code" | "chat" | "notes" | "memory";

export interface SourceDef {
  id: SourceId;
  /** One-letter evidence id prefix (C1109-2 = calendar, Nov 09, 2nd entry). */
  prefix: string;
  label: string;
  group: SourceGroup;
  kinds: readonly string[];
  /** Kinds that are weak evidence on their own (shown last, never "highlights"). */
  lowSignalKinds: readonly string[];
  /** One minimal read the connector check asks the agent to make. Capability wording, no fixed tool names. */
  probe: string;
}

const NOTE_KINDS = ["decision", "proposal", "commitment", "help_given", "help_asked", "recognition", "passive"] as const;

export const SOURCES: readonly SourceDef[] = [
  { id: "calendar", prefix: "C", label: "Calendar", group: "calendar", kinds: ["meeting"], lowSignalKinds: ["meeting"], probe: "list the signed-in user's calendar events for today (limit 1)" },
  { id: "granola", prefix: "G", label: "Meeting notes (Granola)", group: "meeting_notes", kinds: NOTE_KINDS, lowSignalKinds: ["passive"], probe: "list the most recent meeting note in Granola (limit 1)" },
  { id: "fellow", prefix: "F", label: "Meeting notes (Fellow)", group: "meeting_notes", kinds: NOTE_KINDS, lowSignalKinds: ["passive"], probe: "list the most recent meeting summary in Fellow (limit 1)" },
  { id: "jira", prefix: "J", label: "Jira", group: "tracker", kinds: ["resolved", "transitioned", "created", "commented"], lowSignalKinds: [], probe: "identify the signed-in Jira user (current user / myself)" },
  { id: "confluence", prefix: "D", label: "Confluence", group: "docs", kinds: ["doc_created", "doc_edited", "doc_commented"], lowSignalKinds: [], probe: "run one Confluence search for pages the signed-in user contributed to (limit 1)" },
  { id: "github", prefix: "H", label: "GitHub", group: "code", kinds: ["pr_opened", "pr_merged", "review", "review_light", "review_pending"], lowSignalKinds: ["review_light"], probe: "identify the signed-in GitHub user (`gh auth status`, or the GitHub tool's current-user call)" },
  { id: "slack", prefix: "S", label: "Slack", group: "chat", kinds: ["thread_started", "thread_active", "help_given", "help_asked", "kudos", "decision", "watched_channel"], lowSignalKinds: [], probe: "identify the signed-in Slack user (auth / current user)" },
  { id: "vault", prefix: "V", label: "Notes vault", group: "notes", kinds: ["note_written", "log_entry"], lowSignalKinds: [], probe: "list the available notes vaults or folders (limit 1)" },
  { id: "memory", prefix: "M", label: "Agent memory", group: "memory", kinds: ["decision", "outcome", "task", "context"], lowSignalKinds: [], probe: "run one memory search (limit 1)" },
];

export const SOURCE_BY_ID: Readonly<Record<SourceId, SourceDef>> = Object.fromEntries(SOURCES.map((s) => [s.id, s])) as Record<SourceId, SourceDef>;
export const isSourceId = (v: unknown): v is SourceId => typeof v === "string" && (SOURCE_IDS as readonly string[]).includes(v);
export const prefixFor = (id: SourceId): string => SOURCE_BY_ID[id].prefix;
export const kindsFor = (id: SourceId): readonly string[] => SOURCE_BY_ID[id].kinds;
/** Union of every source's low-signal kinds. */
export const LOW_SIGNAL_KINDS: readonly string[] = [...new Set(SOURCES.flatMap((s) => s.lowSignalKinds))];
/**
 * Map a kind from imported data to one this source knows. A known kind stays; an unknown chat kind becomes
 * `watched_channel`; any other source falls back to its first non-low-signal kind.
 */
export function normalizeKind(source: SourceId, kind: string): string {
  const def = SOURCE_BY_ID[source];
  if (def.kinds.includes(kind)) return kind;
  if (def.group === "chat") return "watched_channel";
  return def.kinds.find((k) => !def.lowSignalKinds.includes(k)) ?? def.kinds[0]!;
}
