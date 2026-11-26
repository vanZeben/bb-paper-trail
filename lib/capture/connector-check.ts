/**
 * connector-check.ts — the connector check job. One hidden agent thread makes ONE minimal read per enabled source
 * (the `probe` in the source registry) and reports what it could reach. The reply is validated strictly:
 * a non-boolean `available` throws, unknown ids are dropped and missing ids become "unknown" (`available: null`).
 */
import { READ_ONLY_GUARD, type Job } from "../engine/runner";
import { connectorStateSchema, SOURCE_IDS, type ConnectorCheck, type SourceId } from "../types";
import { isRec, optString } from "./common";
import { isSourceId, SOURCE_BY_ID } from "./sources";

export type ConnectorState = ConnectorCheck["sources"][string];
export type ConnectorSources = Record<string, ConnectorState>;

/** A check older than this is stale and gets re-run (once a week, at the first scheduled week). */
export const CONNECTOR_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** The read-only guard plus one named exception: the GitHub probe may run `gh auth status`. */
export const CONNECTOR_GUARD = `${READ_ONLY_GUARD} One exception, for the GitHub check only: you may run the single read-only shell command \`gh auth status\`. Nothing else in the shell.`;

export const unknownState = (): ConnectorState => ({ available: null, via: null, account: null, note: null, mode: null });

export function connectorCheckPrompt(ids: readonly SourceId[]): string {
  const lines = ids.map((id) => `- ${id} (${SOURCE_BY_ID[id].label}): ${SOURCE_BY_ID[id].probe}`).join("\n");
  const reply = ids.map((id) => `"${id}":{"available":true,"via":"<tool or server name>","account":"<display name or @handle>","note":null${id === "github" ? ',"mode":"gh"' : ""}}`).join(",");
  return `Check which of the user's work connectors you can reach right now. For EACH source below make exactly ONE minimal read (the probe), nothing more. Never fetch real data beyond the probe.

Sources:
${lines}

Rules:
- \`available\` is true only when the probe worked. If no tool for the source exists, or it is not signed in, or the call failed, \`available\` is false and \`note\` says why in a few words.
- \`via\` is the tool, MCP server or command you used. \`account\` is the signed-in display name or \`@handle\` the tool reported, or null if it reported none. Copy values from tool results; never guess.
- \`note\` is ONLY for what you could not read. If the probe fully worked, \`note\` MUST be null.
- For github, also give \`mode\`: "gh" when the \`gh\` command line is signed in, otherwise "mcp" when a GitHub tool is available. Prefer "gh" when both work.
- Include every source id listed above, exactly once.
- Your entire reply must be ONE fenced \`\`\`json block, no prose.

Reply shape:
\`\`\`json
{"sources":{${reply}}}
\`\`\``;
}

/**
 * Validates a connector-check reply for the asked-for source ids. Throws on a malformed reply or a non-boolean
 * `available`; ids that were not asked for (or are unknown) are dropped; asked ids the reply omits become unknown.
 */
export function validateConnectorReply(data: unknown, ids: readonly SourceId[] = SOURCE_IDS): ConnectorSources {
  if (!isRec(data) || !isRec(data.sources)) throw new Error("connector reply needs a `sources` object");
  const raw = data.sources;
  const out: ConnectorSources = {};
  for (const id of ids) {
    const entry = Object.hasOwn(raw, id) ? raw[id] : undefined;
    if (entry === undefined) {
      out[id] = unknownState();
      continue;
    }
    if (!isRec(entry)) throw new Error(`${id} entry is not an object`);
    if (typeof entry.available !== "boolean") throw new Error(`${id}.available must be a boolean`);
    out[id] = connectorStateSchema.parse({
      available: entry.available,
      via: optString(entry.via),
      account: optString(entry.account),
      note: optString(entry.note),
      mode: id === "github" && (entry.mode === "gh" || entry.mode === "mcp") ? entry.mode : null,
    });
  }
  // Ids in the reply that are unknown sources (or not asked for) are dropped by construction.
  return out;
}

export function connectorCheckJob(ids: readonly SourceId[]): Job<ConnectorSources> {
  const asked = ids.filter(isSourceId);
  if (asked.length === 0) throw new Error("no sources to check");
  return { kind: "connector-check", guard: CONNECTOR_GUARD, prompt: connectorCheckPrompt(asked), validate: (data) => validateConnectorReply(data, asked) };
}

/** True when the check is missing or older than a week (an unparseable time counts as stale). */
export function isConnectorCheckStale(check: Pick<ConnectorCheck, "checkedAt"> | null, now: Date): boolean {
  if (check === null) return true;
  const at = Date.parse(check.checkedAt);
  return Number.isNaN(at) || now.getTime() - at > CONNECTOR_STALE_MS;
}
