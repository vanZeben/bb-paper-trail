/** common.ts — rules and small validators shared by the capture jobs. */
import type { Coverage } from "../types";

/** Appended to every capture prompt. */
export const CAPTURE_RULES = `Rules:
- Copy values from tool results; never guess. Use people's names exactly as the tool shows them; if only a login or handle is available write it as \`@login\`. Never derive a name from a login.
- Sensitive: keep other people's compensation, health or HR matters vague ("a personnel matter"); skip anything marked off the record.
- If no tool for this source is available, or it is not signed in, reply \`available:false\` for that source with a \`note\`; if you could only read part of it, \`available:true\` and say what is missing in \`note\`.
- \`note\` is ONLY for data you could not read. When you read everything (including when there was simply no activity), \`note\` MUST be null; never use it to describe what you searched or did.
- Your entire reply must be ONE fenced \`\`\`json block, no prose.`;

export type Rec = Record<string, unknown>;
export const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
export const optString = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
/** https links only; anything else becomes null. */
export const httpsLink = (v: unknown): string | null => {
  const s = optString(v);
  return s !== null && /^https:\/\/\S+$/.test(s) ? s : null;
};

/** available:false -> failed; available:true with a note -> partial; else ok. Throws when `available` is not a boolean. */
export function coverageOf(section: unknown, label: string): Coverage {
  if (!isRec(section)) throw new Error(`${label} section is not an object`);
  if (typeof section.available !== "boolean") throw new Error(`${label}.available must be a boolean`);
  const note = optString(section.note);
  if (!section.available) return { status: "failed", note: note ?? "not available" };
  return { status: note !== null ? "partial" : "ok", note };
}

/** An inclusive date range (YYYY-MM-DD, local dates in the user's time zone). */
export type DateRange = { from: string; to: string };
/** Every date in the range, inclusive (calendar days; callers filter weekdays). */
export const datesIn = (range: DateRange): string[] => {
  const out: string[] = [];
  const end = Date.parse(`${range.to}T00:00:00Z`);
  for (let t = Date.parse(`${range.from}T00:00:00Z`); t <= end; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};

/** Coverage for a source the user disabled or the connector check found unavailable: no job runs, never counts against a rating. */
export const OFF = (note = "not connected"): Coverage => ({ status: "off", note });
