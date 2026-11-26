/**
 * bundle.ts — the data bundle format and the v1 -> v2 record mapping. Pure: no storage, no SDK.
 *
 * A bundle is plain JSON: `{ format: "paper-trail-bundle", version: 1, exportedAt, framework?, timeZoneHint?, days, weeks, records? }`.
 * `days` and `weeks` may hold records of the original single-file work-log (v1: `version: 1`, the field names below)
 * or records of this plugin (v2). v1 records are mapped on import; evidence ids, ratings and timestamps are copied as is.
 */
import { z } from "zod";
import { isSourceId, normalizeKind, prefixFor } from "../../capture/sources";
import { oneLine, withAllSources } from "../../engine/evidence";
import {
  EVIDENCE_ID_RE, MAX_CLAIM, MAX_EVIDENCE_PER_SOURCE, MAX_OUTCOME, MAX_REASON, MAX_SUMMARY, MAX_WHAT, SOURCE_IDS,
  allocationTargetsSchema, claimSchema, clip, closureNoteSchema, coverageSchema, dateStr, dayRatingSchema, ghostClusterSchema, guardrailRuleSchema,
  isHttpsUrl, overrideSchema, roleFrameworkSchema, slug, threadEditSchema, weekAddendaSchema, weekMeetingsSchema, weekPlanSchema, weekStr,
  workDaySchema, workWeekSchema, type CoverageMap, type EvidenceEntry, type RoleFramework, type WorkDay, type WorkMeeting, type WorkWeek,
} from "../../types";
import { KIND } from "../../storage/port";
import { BUNDLE_FORMAT, BUNDLE_VERSION, LEGACY_BUNDLE_FORMAT } from "./formats";

export { BUNDLE_FORMAT, BUNDLE_VERSION, LEGACY_BUNDLE_FORMAT };

/** Import limits: a bundle is untrusted input, so size and counts are capped before any deep work. */
export const MAX_BUNDLE_CHARS = 25 * 1024 * 1024;
export const MAX_BUNDLE_DAYS = 2000;
export const MAX_BUNDLE_WEEKS = 400;
export const MAX_BUNDLE_RECORDS = 20000;
export const MAX_MEETINGS = 25;
const MAX_CLAIMS = 50;
const MAX_NOTE = 300;
const MAX_EXT_CHARS = 20_000;
const MAX_RECORD_CHARS = 200_000;
/** The original allowed longer reflections than the 500 characters this plugin writes. */
const MAX_REFLECTION = 2000;

// ─── envelope ───────────────────────────────────────────────────────────────

export const bundleRecordSchema = z.object({ kind: z.string().min(1).max(40), id: z.string().min(1).max(200), value: z.unknown() });
export type BundleRecord = z.infer<typeof bundleRecordSchema>;

/** `days` / `weeks` stay `unknown[]` here: each item is validated on its own, so one bad record never rejects the bundle. */
export const bundleSchema = z.object({
  format: z.union([z.literal(BUNDLE_FORMAT), z.literal(LEGACY_BUNDLE_FORMAT)]),
  version: z.literal(BUNDLE_VERSION),
  exportedAt: z.string(),
  framework: roleFrameworkSchema.optional(),
  /** Informational: the zone the dates in the bundle were produced in. Never applied to the settings. */
  timeZoneHint: z.string().optional(),
  days: z.array(z.unknown()).max(MAX_BUNDLE_DAYS),
  weeks: z.array(z.unknown()).max(MAX_BUNDLE_WEEKS),
  records: z.array(bundleRecordSchema).max(MAX_BUNDLE_RECORDS).optional(),
});
export type Bundle = z.infer<typeof bundleSchema>;

/** Throws a plain Error naming the first problems. */
export function parseBundle(input: unknown): Bundle {
  let size = 0;
  try {
    size = JSON.stringify(input)?.length ?? 0;
  } catch {
    throw new Error(`Not a ${BUNDLE_FORMAT}: it is not plain JSON`);
  }
  if (size > MAX_BUNDLE_CHARS) throw new Error(`Bundle is too large (${Math.round(size / 1048576)} MB; the limit is ${MAX_BUNDLE_CHARS / 1048576} MB)`);
  const parsed = bundleSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "bundle"}: ${i.message}`);
  throw new Error(`Not a ${BUNDLE_FORMAT} (version ${BUNDLE_VERSION}): ${issues.join("; ")}`);
}

// ─── v1 records (the original plugin's stored shapes) ───────────────────────

/** The original names of fields that were renamed. */
export const V1_FIELDS = {
  meetingNoted: "granola",
  /** Any `raiseWith<Name>` key (the original named it after the manager) is the `raiseWithManager` list. */
  raiseWithKey: /^raiseWith[A-Z]\w*$/,
  raiseWithManager: "raiseWithManager",
} as const;

const v1Evidence = z.object({
  id: z.string(),
  date: z.string(),
  source: z.string(),
  kind: z.string(),
  what: z.string(),
  link: z.string().nullable(),
  outcome: z.string().nullable(),
});
const v1Meeting = z.object({
  id: z.string(),
  title: z.string(),
  start: z.string(),
  end: z.string(),
  minutes: z.number(),
  response: z.enum(["accepted", "tentative", "needsAction", "organizer", "unknown"]),
  attendees: z.number().nullable(),
  passive: z.boolean().nullable(),
  /** Renamed from `V1_FIELDS.meetingNoted` before parsing (see `renamed`). */
  noted: z.boolean(),
});
const v1Day = z.object({
  version: z.literal(1),
  date: z.string(),
  week: z.string(),
  capturedAt: z.string(),
  coverage: z.record(z.string(), coverageSchema),
  meetings: z.array(v1Meeting).default([]),
  meetingCount: z.number(),
  meetingMinutes: z.number(),
  evidence: z.array(v1Evidence).default([]),
  rating: dayRatingSchema.nullable(),
});
const v1Week = z.object({
  version: z.literal(1),
  week: z.string(),
  from: z.string(),
  to: z.string(),
  generatedAt: z.string(),
  model: z.string().nullable(),
  final: z.boolean(),
  rating: workWeekSchema.shape.rating,
  ratingReason: z.string(),
  threeLines: z.array(z.string()),
  days: workWeekSchema.shape.days,
  daysWorked: z.number(),
  scorecard: workWeekSchema.shape.scorecard,
  shipped: z.array(claimSchema).default([]),
  inProgress: z.array(claimSchema).default([]),
  decisions: z.array(claimSchema).default([]),
  helping: z.array(claimSchema).default([]),
  meetings: weekMeetingsSchema,
  recognition: z.array(claimSchema).default([]),
  openAsks: z.array(claimSchema).default([]),
  friction: z.array(claimSchema).default([]),
  /** Renamed from `V1_FIELDS.raiseWithManager` before parsing (see `renamed`). */
  raiseWithManager: z.array(claimSchema).default([]),
  reflection: workWeekSchema.shape.reflection,
  coverage: z.record(z.string(), coverageSchema),
  evidence: z.array(v1Evidence).default([]),
  // `notePath` (the original's vault note path) is not part of the schema, so parsing drops it.
});

const mapEvidence = (e: z.infer<typeof v1Evidence>) => ({ ...e, kind: isSourceId(e.source) ? normalizeKind(e.source, e.kind) : e.kind, area: null });

/** A shallow copy with `from` moved to `to` (when `to` is not already there). */
const renamed = (raw: unknown, from: string, to: string): unknown => {
  if (typeof raw !== "object" || raw === null || !(from in raw) || to in raw) return raw;
  const { [from]: value, ...rest } = raw as Record<string, unknown>;
  return { ...rest, [to]: value };
};

/** Move the first key matching `pattern` (and not already `to`) onto `to`. */
const renamedLike = (raw: unknown, pattern: RegExp, to: string): unknown => {
  if (typeof raw !== "object" || raw === null || to in raw) return raw;
  const from = Object.keys(raw).find((k) => pattern.test(k));
  return from === undefined ? raw : renamed(raw, from, to);
};

/** v1 day -> v2 day. */
export function mapDayV1(raw: unknown): WorkDay {
  const input = typeof raw === "object" && raw !== null && Array.isArray((raw as { meetings?: unknown }).meetings)
    ? { ...(raw as object), meetings: (raw as { meetings: unknown[] }).meetings.map((m) => renamed(m, V1_FIELDS.meetingNoted, "noted")) }
    : raw;
  const day = v1Day.parse(input);
  return workDaySchema.parse({ ...day, version: 2, coverage: withAllSources(day.coverage), evidence: day.evidence.map(mapEvidence) });
}

/** v1 week -> v2 week. `framework` supplies `frameworkId` and `areasSnapshot` (the area keys are copied unchanged). */
export function mapWeekV1(raw: unknown, framework: RoleFramework): WorkWeek {
  const week = v1Week.parse(renamedLike(raw, V1_FIELDS.raiseWithKey, V1_FIELDS.raiseWithManager));
  return workWeekSchema.parse({
    ...week,
    version: 2,
    coverage: withAllSources(week.coverage),
    evidence: week.evidence.map(mapEvidence),
    frameworkId: framework.id,
    areasSnapshot: framework.areas.map((a) => ({ key: a.key, label: a.label })),
    plan: [],
    ext: {},
  });
}

/** Version of a raw day/week item: 1, 2 or null when it has none. */
export const recordVersion = (raw: unknown): number | null => {
  const v = typeof raw === "object" && raw !== null ? (raw as { version?: unknown }).version : undefined;
  return typeof v === "number" ? v : null;
};

const checked = <T extends { date?: string; week?: string }>(record: T, key: "date" | "week"): T => {
  const value = record[key];
  const ok = key === "date" ? dateStr.safeParse(value).success : weekStr.safeParse(value).success;
  if (!ok) throw new Error(`invalid ${key} "${String(value)}"`);
  return record;
};

// ─── import-side limits ─────────────────────────────────────────────────────
// A bundle is a file from elsewhere: every string that can reach a prompt or the UI is bounded, ids must look like
// ids, links must be https, and evidence text is single-line. A violation rejects that one day or week (it lands in
// the import's `errors`); it never fails the whole import.

const KIND_RE = /^[a-z][a-z0-9_]{0,39}$/;
const TIME_MAX = 40;

function fail(message: string): never {
  throw new Error(message);
}
function maxLen(label: string, value: string, max: number): void {
  if (value.length > max) fail(`${label} is too long (${value.length} characters; the limit is ${max})`);
}
function checkIds(label: string, ids: readonly string[], max = 200): void {
  if (ids.length > max) fail(`${label} lists too many evidence ids`);
  for (const id of ids) if (!EVIDENCE_ID_RE.test(id)) fail(`${label} has a bad evidence id ${JSON.stringify(clip(id, 24))}`);
}
function checkLink(label: string, link: string | null): void {
  if (link !== null && !isHttpsUrl(link)) fail(`${label} has a link that is not https`);
}
const oneClipped = (text: string, max: number): string => clip(oneLine(text), max);

function sanitizeCoverage(coverage: CoverageMap): CoverageMap {
  const out: CoverageMap = {};
  for (const source of SOURCE_IDS) {
    const c = coverage[source];
    if (c !== undefined) out[source] = { status: c.status, note: c.note === null ? null : oneClipped(c.note, MAX_NOTE) };
  }
  return out;
}

/** Evidence: id, source and link checked; at most 25 per source per date; text is one line, clipped. */
function sanitizeEvidence(list: readonly EvidenceEntry[], label: string): EvidenceEntry[] {
  const perSource = new Map<string, number>();
  const seen = new Set<string>();
  return list.map((e, i) => {
    const at = `${label} evidence #${i + 1}`;
    if (!isSourceId(e.source)) fail(`${at} has an unknown source`);
    if (!EVIDENCE_ID_RE.test(e.id) || e.id[0] !== prefixFor(e.source)) fail(`${at} has a bad id ${JSON.stringify(clip(e.id, 24))}`);
    if (seen.has(e.id)) fail(`${at} repeats id ${e.id}`);
    seen.add(e.id);
    if (!dateStr.safeParse(e.date).success) fail(`${at} has a bad date`);
    const key = `${e.date}|${e.source}`;
    const count = (perSource.get(key) ?? 0) + 1;
    perSource.set(key, count);
    if (count > MAX_EVIDENCE_PER_SOURCE) fail(`${label} has more than ${MAX_EVIDENCE_PER_SOURCE} ${e.source} entries on ${e.date}`);
    checkLink(at, e.link);
    if (!KIND_RE.test(e.kind)) fail(`${at} has a bad kind`);
    return {
      id: e.id,
      date: e.date,
      source: e.source,
      kind: e.kind,
      what: oneClipped(e.what, MAX_WHAT),
      link: e.link,
      outcome: e.outcome === null ? null : oneClipped(e.outcome, MAX_OUTCOME),
      area: e.area !== null && slug.safeParse(e.area).success ? e.area : null,
    };
  });
}

function sanitizeMeetings(list: readonly WorkMeeting[], label: string): WorkMeeting[] {
  if (list.length > MAX_MEETINGS) fail(`${label} has more than ${MAX_MEETINGS} meetings`);
  return list.map((m) => {
    maxLen(`${label} meeting id`, m.id, 40);
    maxLen(`${label} meeting time`, m.start, TIME_MAX);
    maxLen(`${label} meeting time`, m.end, TIME_MAX);
    return { ...m, title: oneClipped(m.title, MAX_WHAT) };
  });
}

function checkDayRating(label: string, r: { reason: string; summary: string; areas: string[]; evidenceIds: string[]; ratedAt: string; model: string | null }): void {
  maxLen(`${label} reason`, r.reason, MAX_REASON);
  maxLen(`${label} summary`, r.summary, MAX_SUMMARY);
  maxLen(`${label} ratedAt`, r.ratedAt, TIME_MAX);
  if (r.model !== null) maxLen(`${label} model`, r.model, 80);
  if (r.areas.length > 12 || r.areas.some((a) => a.length > 40)) fail(`${label} lists too many or too long areas`);
  checkIds(label, r.evidenceIds);
}

function checkClaims(label: string, claims: readonly { text: string; evidenceIds: string[] }[]): void {
  if (claims.length > MAX_CLAIMS) fail(`${label} has more than ${MAX_CLAIMS} entries`);
  for (const c of claims) {
    maxLen(label, c.text, MAX_CLAIM);
    checkIds(label, c.evidenceIds);
  }
}

/** Apply the import limits to one validated day. Throws a short message. */
export function sanitizeDay(day: WorkDay): WorkDay {
  const label = `day ${day.date}`;
  maxLen(`${label} capturedAt`, day.capturedAt, TIME_MAX);
  if (!weekStr.safeParse(day.week).success) fail(`${label} has a bad week`);
  if (day.rating !== null) checkDayRating(`${label} rating`, day.rating);
  return {
    ...day,
    coverage: sanitizeCoverage(day.coverage),
    meetings: sanitizeMeetings(day.meetings, label),
    evidence: sanitizeEvidence(day.evidence, label),
  };
}

/** Apply the import limits to one validated week. Throws a short message. */
export function sanitizeWeek(week: WorkWeek): WorkWeek {
  const label = `week ${week.week}`;
  maxLen(`${label} ratingReason`, week.ratingReason, MAX_REASON);
  maxLen(`${label} generatedAt`, week.generatedAt, TIME_MAX);
  if (!dateStr.safeParse(week.from).success || !dateStr.safeParse(week.to).success) fail(`${label} has a bad date range`);
  if (week.model !== null) maxLen(`${label} model`, week.model, 80);
  if (week.threeLines.length > 3) fail(`${label} has more than 3 summary lines`);
  for (const line of week.threeLines) maxLen(`${label} summary line`, line, MAX_CLAIM);
  if (week.days.length > 7) fail(`${label} has more than 7 days`);
  for (const d of week.days) {
    if (!dateStr.safeParse(d.date).success) fail(`${label} has a bad day date`);
    maxLen(`${label} day reason`, d.reason, MAX_REASON);
    maxLen(`${label} day summary`, d.summary, MAX_SUMMARY);
    checkIds(`${label} day`, d.evidenceIds);
  }
  if (week.scorecard.length > 20) fail(`${label} has too many scorecard rows`);
  for (const row of week.scorecard) {
    maxLen(`${label} scorecard area`, row.area, 40);
    maxLen(`${label} scorecard note`, row.note, MAX_REASON);
    checkIds(`${label} scorecard`, row.evidenceIds);
  }
  for (const key of ["shipped", "inProgress", "decisions", "helping", "recognition", "openAsks", "friction", "raiseWithManager"] as const) checkClaims(`${label} ${key}`, week[key]);
  maxLen(`${label} reflection`, week.reflection.text, MAX_REFLECTION);
  if (week.meetings.topSinks.length > 20) fail(`${label} has too many meeting sinks`);
  if (week.plan.length > 50) fail(`${label} has too many plan results`);
  for (const r of week.plan) {
    maxLen(`${label} plan note`, r.note, MAX_REASON);
    checkIds(`${label} plan`, r.evidenceIds);
  }
  if (week.areasSnapshot.length > 20) fail(`${label} has too many areas`);
  if (JSON.stringify(week.ext).length > MAX_EXT_CHARS) fail(`${label} extension data is too large`);
  return {
    ...week,
    coverage: sanitizeCoverage(week.coverage),
    evidence: sanitizeEvidence(week.evidence, label),
    meetings: { ...week.meetings, topSinks: week.meetings.topSinks.map((s) => ({ ...s, title: oneClipped(s.title, MAX_WHAT) })) },
  };
}

/** Validate and, for v1, map one day. Throws with a short message. */
export function normalizeDay(raw: unknown): WorkDay {
  const version = recordVersion(raw);
  if (version === 1) return sanitizeDay(checked(mapDayV1(raw), "date"));
  if (version === 2) return sanitizeDay(checked(workDaySchema.parse(raw), "date"));
  throw new Error("missing or unknown version (expected 1 or 2)");
}

/** Validate and, for v1, map one week. Throws with a short message. */
export function normalizeWeek(raw: unknown, framework: RoleFramework): WorkWeek {
  const version = recordVersion(raw);
  if (version === 1) return sanitizeWeek(checked(mapWeekV1(raw, framework), "week"));
  if (version === 2) return sanitizeWeek(checked(workWeekSchema.parse(raw), "week"));
  throw new Error("missing or unknown version (expected 1 or 2)");
}

// ─── feature records ────────────────────────────────────────────────────────

const OVERRIDE_ID = /^(day:\d{4}-\d{2}-\d{2}|week:\d{4}-W\d{2}|scorecard:\d{4}-W\d{2}:[a-z][a-z0-9_]{1,31})$/;

export interface RecordSpec {
  kind: string;
  schema: z.ZodType<unknown>;
  /** Is this id valid for this kind (and, where the value names its own id, does it match)? */
  validId(id: string, value: unknown): boolean;
  /** Sortable timestamp inside the value, when there is one (newer wins on import). */
  stamp?(value: unknown): string | null;
  /** The week or date an id belongs to, for range filters on export; null = not time-bound. */
  weekOf?(id: string): string | null;
  dateOf?(id: string): string | null;
  /** Import rule for a record that already exists; default: the newer stamp wins, no stamp means the stored one is kept. */
  replaces?(stored: unknown, incoming: unknown): boolean;
}

const at = (key: string) => (value: unknown): string | null => {
  const v = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
  return typeof v === "string" ? v : null;
};
const weekId = (id: string) => (weekStr.safeParse(id).success ? id : null);

/** Everything a bundle may carry besides days and weeks. Derived records (drift, violations, threads, mix, packets) are rebuilt, never exported. */
export const RECORD_SPECS: Record<string, RecordSpec> = {
  [KIND.framework]: { kind: KIND.framework, schema: roleFrameworkSchema, validId: (id) => id === "active", stamp: at("updatedAt") },
  [KIND.targets]: { kind: KIND.targets, schema: allocationTargetsSchema, validId: (id) => id === "active", stamp: at("updatedAt") },
  [KIND.rules]: { kind: KIND.rules, schema: z.array(guardrailRuleSchema), validId: (id) => id === "active" },
  [KIND.override]: {
    kind: KIND.override,
    schema: overrideSchema,
    validId: (id) => OVERRIDE_ID.test(id),
    stamp: at("at"),
    weekOf: (id) => (id.startsWith("week:") ? id.slice(5) : id.startsWith("scorecard:") ? id.split(":")[1] ?? null : null),
    dateOf: (id) => (id.startsWith("day:") ? id.slice(4) : null),
  },
  [KIND.plan]: { kind: KIND.plan, schema: weekPlanSchema, validId: (id, v) => weekStr.safeParse(id).success && (v as { week?: string }).week === id, weekOf: weekId },
  [KIND.addenda]: { kind: KIND.addenda, schema: weekAddendaSchema, validId: (id, v) => weekStr.safeParse(id).success && (v as { week?: string }).week === id, stamp: at("updatedAt"), weekOf: weekId },
  [KIND.closure]: { kind: KIND.closure, schema: closureNoteSchema, validId: (id, v) => id.length > 0 && (v as { threadId?: string }).threadId === id, stamp: at("at") },
  [KIND.threadEdit]: { kind: KIND.threadEdit, schema: threadEditSchema, validId: (id, v) => id.length > 0 && (v as { threadId?: string }).threadId === id },
  [KIND.ghost]: {
    kind: KIND.ghost,
    schema: ghostClusterSchema,
    validId: (id, v) => id.length > 0 && (v as { id?: string }).id === id,
    // Clusters are rebuilt from the weeks; only a decision (claimed / dismissed) is worth carrying over a fresh "new".
    replaces: (stored, incoming) => (stored as { state?: string }).state === "new" && (incoming as { state?: string }).state !== "new",
  },
};

export const RECORD_KINDS: readonly string[] = Object.keys(RECORD_SPECS);

export interface ValidRecord {
  kind: string;
  id: string;
  value: unknown;
  spec: RecordSpec;
}

/** Validate one bundle record against its kind. Throws with a short message. */
export function validateRecord(rec: BundleRecord): ValidRecord {
  const spec = RECORD_SPECS[rec.kind];
  if (spec === undefined) throw new Error(`unsupported record kind "${rec.kind}"`);
  if (JSON.stringify(rec.value ?? null).length > MAX_RECORD_CHARS) throw new Error(`${rec.kind}/${rec.id}: value is too large`);
  const parsed = spec.schema.safeParse(rec.value);
  if (!parsed.success) throw new Error(`${rec.kind}/${rec.id}: ${parsed.error.issues[0]?.message ?? "invalid value"}`);
  if (!spec.validId(rec.id, parsed.data)) throw new Error(`${rec.kind}: unexpected id "${rec.id}"`);
  return { kind: rec.kind, id: rec.id, value: parsed.data, spec };
}

/** Should `incoming` overwrite `stored`? (Both are valid values of the spec's kind.) */
export function shouldReplace(spec: RecordSpec, stored: unknown, incoming: unknown): boolean {
  if (spec.replaces) return spec.replaces(stored, incoming);
  const a = spec.stamp?.(stored) ?? null;
  const b = spec.stamp?.(incoming) ?? null;
  if (a === null || b === null) return false;
  return Date.parse(b) > Date.parse(a);
}

/** The instant a stored day was last touched (capture or rating); used to decide whether a bundle is newer. */
export const dayStamp = (d: WorkDay): number => Math.max(ms(d.capturedAt), ms(d.rating?.ratedAt));
export const weekStamp = (w: WorkWeek): number => ms(w.generatedAt);
function ms(iso: string | undefined | null): number {
  const t = iso == null ? Number.NaN : Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}
