/** json.ts — reply parsing. */

/**
 * Extract the JSON payload from an agent reply. Prefers the LAST ```json fence;
 * falls back to the whole reply if it is bare JSON. Throws on anything else.
 */
export function extractJson(text: string): unknown {
  if (typeof text !== "string" || !text.trim()) throw new Error("empty reply");
  const fences = [...text.matchAll(/```(?:json)?[ \t]*\n([\s\S]*?)```/g)];
  const raw = fences.length ? fences[fences.length - 1]![1]! : text.trim();
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`reply is not valid JSON: ${(err as Error).message}`);
  }
}

export const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
