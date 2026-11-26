/**
 * types.ts — every stored and RPC schema (zod 4). Single owner: the scaffold; feature agents extend by adding
 * records, never by editing a shared schema without telling the scaffold owner.
 */
import { z } from "zod";

// ─── sources ────────────────────────────────────────────────────────────────
// The registry (id, prefix, label, kinds, probe) lives in capture/sources.ts; these are the ids stored data uses.
export const SOURCE_IDS = ["calendar", "granola", "fellow", "jira", "confluence", "github", "slack", "vault", "memory"] as const;
export type SourceId = (typeof SOURCE_IDS)[number];
export const RATINGS = ["exceeds", "meets", "needs_improvement", "none"] as const;
export type Rating = (typeof RATINGS)[number];
/** e.g. C1109-2 = calendar, Nov 09, 2nd entry. */
export const EVIDENCE_ID_RE = /^[CGFJDHSVM]\d{4}-\d{1,3}$/;
export const MAX_EVIDENCE_PER_SOURCE = 25;
export const MAX_BACKFILL_WEEKS = 40;
export const MAX_WHAT = 240;
export const MAX_OUTCOME = 200;
export const MAX_REASON = 200;
export const MAX_SUMMARY = 500;
export const MAX_CLAIM = 300;

export const slug = z.string().regex(/^[a-z][a-z0-9_]{1,31}$/);
export const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const weekStr = z.string().regex(/^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/);
export const severity = z.enum(["info", "warning", "breach"]);
export type Severity = z.infer<typeof severity>;
/** Links are https only. Anything else reads as "no link" (so one odd stored value never hides a whole record). */
export const isHttpsUrl = (v: unknown): v is string => typeof v === "string" && v.length <= 2000 && /^https:\/\/\S+$/.test(v);
export const httpsLinkSchema = z.string().nullable().transform((v) => (isHttpsUrl(v) ? v : null));
export const evidenceRef = z.object({ date: dateStr, id: z.string(), link: httpsLinkSchema });
export type EvidenceRef = z.infer<typeof evidenceRef>;
export const ok = z.object({ ok: z.literal(true) });

const rating = z.enum(RATINGS);
const covStatus = z.enum(["ok", "partial", "failed", "off"]);
export type CovStatus = z.infer<typeof covStatus>;

export const coverageSchema = z.object({ status: covStatus, note: z.string().nullable() });
export type Coverage = z.infer<typeof coverageSchema>;
/** Sources added after a day was stored default to "not captured", so a re-run fetches only them. */
export const NOT_CAPTURED: Coverage = { status: "failed", note: "not captured" };
/** A record keyed by source id; `withAllSources` (engine/evidence.ts) fills the gaps. */
export const coverageMapSchema = z.record(z.string(), coverageSchema);
export type CoverageMap = z.infer<typeof coverageMapSchema>;

export const evidenceEntrySchema = z.object({
  id: z.string(),
  date: z.string(),
  source: z.string(),
  kind: z.string(),
  what: z.string(),
  link: z.string().nullable(),
  outcome: z.string().nullable(),
  /** Reserved for per-evidence area tagging (v2). Null in v1. */
  area: z.string().nullable().default(null),
});
export type EvidenceEntry = z.infer<typeof evidenceEntrySchema>;

export const workMeetingSchema = z.object({
  id: z.string(),
  title: z.string(),
  start: z.string(),
  end: z.string(),
  minutes: z.number(),
  response: z.enum(["accepted", "tentative", "needsAction", "organizer", "unknown"]),
  attendees: z.number().nullable(),
  noted: z.boolean(),
  passive: z.boolean().nullable(),
});
export type WorkMeeting = z.infer<typeof workMeetingSchema>;

export const dayRatingSchema = z.object({
  rating,
  provisional: z.boolean(),
  reason: z.string(),
  summary: z.string(),
  areas: z.array(z.string()).default([]),
  evidenceIds: z.array(z.string()).default([]),
  ratedAt: z.string(),
  model: z.string().nullable(),
  /** The day was re-captured after this rating was made; the rating has not been redone yet. */
  stale: z.boolean().optional(),
});
export type DayRating = z.infer<typeof dayRatingSchema>;

export const workDaySchema = z.object({
  version: z.literal(2),
  date: z.string(),
  week: z.string(),
  capturedAt: z.string(),
  coverage: coverageMapSchema,
  meetings: z.array(workMeetingSchema).default([]),
  meetingCount: z.number(),
  meetingMinutes: z.number(),
  evidence: z.array(evidenceEntrySchema).default([]),
  rating: dayRatingSchema.nullable(),
});
export type WorkDay = z.infer<typeof workDaySchema>;

export const claimSchema = z.object({ text: z.string(), evidenceIds: z.array(z.string()).default([]) });
export type Claim = z.infer<typeof claimSchema>;

export const weekMeetingsSchema = z.object({
  count: z.number(),
  hours: z.number(),
  pctOfWeek: z.number(),
  passiveCount: z.number(),
  topSinks: z.array(z.object({ title: z.string(), hours: z.number() })).default([]),
});
export type WeekMeetings = z.infer<typeof weekMeetingsSchema>;

export const scorecardStatus = z.enum(["hit", "partial", "missed"]);

// ─── 1. Role framework ──────────────────────────────────────────────────────
export const roleAreaSchema = z.object({
  key: slug,
  label: z.string().max(80),
  description: z.string().max(400),
  kind: z.enum(["leverage", "hands_on", "other"]).default("other"),
});
export type RoleAreaDef = z.infer<typeof roleAreaSchema>;
export const roleFrameworkSchema = z.object({
  version: z.literal(1),
  id: slug,
  name: z.string().max(80),
  subject: z.object({ name: z.string().max(60).default("the user"), pronoun: z.enum(["they", "he", "she"]).default("they") }),
  managerName: z.string().max(60).nullable().default(null),
  areas: z.array(roleAreaSchema).min(2).max(10),
  /** old key -> current key, for renames */
  areaAliases: z.record(z.string(), slug).default({}),
  roleDoc: z.string().max(6000).default(""),
  supplementDocs: z.array(z.object({ title: z.string().max(80), text: z.string().max(5000) })).max(3).default([]),
  rubric: z.object({
    bar: z.string().max(300),
    exceeds: z.string().max(800),
    meets: z.string().max(800),
    needsImprovement: z.string().max(800),
    extraRules: z.array(z.string().max(300)).max(12).default([]),
  }),
  updatedAt: z.string(),
});
export type RoleFramework = z.infer<typeof roleFrameworkSchema>;
export const frameworkProposalSchema = z.object({
  status: z.enum(["running", "ready", "failed"]),
  sourceRef: z.string(),
  framework: roleFrameworkSchema.nullable(),
  error: z.string().nullable(),
  at: z.string(),
});
export type FrameworkProposal = z.infer<typeof frameworkProposalSchema>;
export const areaSnapshotSchema = z.object({ key: z.string(), label: z.string() });
export type AreaSnapshot = z.infer<typeof areaSnapshotSchema>;

// ─── 2. Week (needs plan results, defined below) ────────────────────────────
// 5. Planned vs done
export const planRefSchema = z.object({
  kind: z.enum(["ticket", "pr", "doc", "meeting"]),
  label: z.string().max(120),
  url: z.string().nullable(),
  date: dateStr.nullable(),
});
export type PlanRef = z.infer<typeof planRefSchema>;
export const planItemSchema = z.object({
  id: z.string(),
  week: weekStr,
  text: z.string().min(1).max(200),
  area: slug.nullable(),
  source: z.enum(["manual", "external", "note", "inferred"]),
  externalRef: z.string().nullable(),
  carriedFrom: z.string().nullable(),
  carryCount: z.number().int().default(0),
  createdAt: z.string(),
  /** Goal and goal-task this commitment serves (ids in the goals record), when it serves one. */
  goalId: z.string().nullable().default(null),
  taskId: z.string().nullable().default(null),
  kind: z.enum(["deliver", "decide", "review", "prep", "unblock", "other"]).default("other"),
  /** The mark: what done looks like and how the judge can see it. */
  doneWhen: z.string().max(200).default(""),
  refs: z.array(planRefSchema).max(4).default([]),
});
export const planResultSchema = z.object({
  itemId: z.string(),
  status: z.enum(["done", "partial", "not_done", "dropped"]),
  note: z.string().max(200),
  evidenceIds: z.array(z.string()).default([]),
});
export type PlanItem = z.infer<typeof planItemSchema>;
export type PlanResult = z.infer<typeof planResultSchema>;
export const weekPlanSchema = z.object({
  week: weekStr,
  items: z.array(planItemSchema).max(7),
  results: z.array(planResultSchema).default([]),
  hitRate: z.number().nullable(),
  judgedAt: z.string().nullable(),
  /** The week's intent: one headline, why, and the 1-2 goals in focus. */
  intent: z.object({ headline: z.string().max(140), why: z.string().max(400), focusGoalIds: z.array(z.string()).max(2) }).nullable().default(null),
  /** Calendar shape of the week, from the scan. */
  shape: z
    .object({
      meetingHours: z.number(),
      meetingCount: z.number(),
      focusHours: z.number(),
      keyMeetings: z.array(z.object({ title: z.string().max(120), date: dateStr, why: z.string().max(160) })).max(5),
    })
    .nullable()
    .default(null),
  backlog: z
    .object({ considered: z.number(), deferred: z.array(z.object({ label: z.string().max(120), why: z.string().max(160) })).max(5) })
    .nullable()
    .default(null),
  /** End-of-week retro from the judge. */
  retro: z
    .object({ summary: z.string().max(400), derailers: z.array(z.object({ text: z.string().max(200), evidenceIds: z.array(z.string()) })).max(4) })
    .nullable()
    .default(null),
  /** Share of substantive evidence not cited by any commitment's result; computed deterministically. */
  unplannedShare: z.number().nullable().default(null),
  plannedAt: z.string().nullable().default(null),
  plannedFor: z.enum(["auto", "setup", "manual_trigger"]).nullable().default(null),
});
export type WeekPlan = z.infer<typeof weekPlanSchema>;
export const planAccuracySchema = z.object({
  byWeek: z.array(z.object({ week: weekStr, hitRate: z.number().nullable(), committed: z.number(), hit: z.number() })),
  overall: z.number().nullable(),
  note: z.string(),
});
export type PlanAccuracy = z.infer<typeof planAccuracySchema>;

export const workWeekSchema = z.object({
  version: z.literal(2),
  week: z.string(),
  from: z.string(),
  to: z.string(),
  generatedAt: z.string(),
  model: z.string().nullable(),
  final: z.boolean(),
  rating,
  ratingReason: z.string(),
  threeLines: z.array(z.string()),
  days: z.array(z.object({ date: z.string(), rating, reason: z.string(), summary: z.string(), evidenceIds: z.array(z.string()).default([]) })),
  daysWorked: z.number(),
  scorecard: z.array(z.object({ area: z.string(), status: scorecardStatus, note: z.string(), evidenceIds: z.array(z.string()).default([]) })),
  shipped: z.array(claimSchema).default([]),
  inProgress: z.array(claimSchema).default([]),
  decisions: z.array(claimSchema).default([]),
  helping: z.array(claimSchema).default([]),
  meetings: weekMeetingsSchema,
  recognition: z.array(claimSchema).default([]),
  openAsks: z.array(claimSchema).default([]),
  friction: z.array(claimSchema).default([]),
  raiseWithManager: z.array(claimSchema).default([]),
  reflection: z.object({ goodWeek: z.boolean(), text: z.string() }),
  coverage: coverageMapSchema,
  evidence: z.array(evidenceEntrySchema).default([]),
  frameworkId: z.string().default("default"),
  areasSnapshot: z.array(areaSnapshotSchema).default([]),
  plan: z.array(planResultSchema).default([]),
  /** Validated extras from PromptExtensions, keyed by extension id. */
  ext: z.record(z.string(), z.unknown()).default({}),
});
export type WorkWeek = z.infer<typeof workWeekSchema>;

// ─── index and grid ─────────────────────────────────────────────────────────
export const indexDaySchema = z.object({
  rating: rating.nullable(),
  provisional: z.boolean(),
  reason: z.string().nullable(),
  meetingMinutes: z.number(),
  evidenceCount: z.number(),
  worstCoverage: covStatus,
  areas: z.array(z.string()).default([]),
  evidenceBySource: z.record(z.string(), z.number()).default({}),
  coverage: z.record(z.string(), covStatus).default({}),
});
export const worklogIndexSchema = z.object({
  version: z.literal(2).default(2),
  days: z.record(z.string(), indexDaySchema),
  weeks: z.record(z.string(), z.object({ rating, final: z.boolean(), generatedAt: z.string() })),
});
export type WorklogIndex = z.infer<typeof worklogIndexSchema>;

export const worklogStatusSchema = z.object({
  running: z.object({ key: z.string(), startedAt: z.string(), step: z.string().nullable() }).nullable(),
  queued: z.array(z.string()),
  lastError: z.object({ key: z.string(), message: z.string(), at: z.string() }).nullable(),
});
export type WorklogStatus = z.infer<typeof worklogStatusSchema>;

export const gridCellSchema = z.object({
  date: z.string(),
  state: z.enum(["future", "empty", "unrated", "rated"]),
  /** The effective rating (override applied when a GridContributor sets one). */
  rating: rating.nullable(),
  provisional: z.boolean(),
  reason: z.string().nullable(),
  meetingHours: z.number().nullable(),
  worstCoverage: covStatus.nullable(),
  // lens fields
  aiRating: rating.nullable().default(null),
  overridden: z.boolean().default(false),
  areas: z.array(z.string()).default([]),
  meetingPct: z.number().nullable().default(null),
  evidenceCount: z.number().default(0),
  evidenceBySource: z.record(z.string(), z.number()).default({}),
  planAdvanced: z.number().nullable().default(null),
  coverage: z.record(z.string(), covStatus).default({}),
});
export type GridCell = z.infer<typeof gridCellSchema>;
export const weekMarkersSchema = z.object({
  guardrail: severity.nullable().default(null),
  guardrailCount: z.number().default(0),
  drift: z.enum(["watch", "off"]).nullable().default(null),
  shipped: z.number().default(0),
  needClosure: z.number().default(0),
  planHitRate: z.number().nullable().default(null),
});
export type WeekMarkers = z.infer<typeof weekMarkersSchema>;
export const gridWeekSchema = z.object({
  week: z.string(),
  from: z.string(),
  label: z.string(),
  monthLabel: z.string().nullable(),
  rating: rating.nullable(),
  final: z.boolean(),
  cells: z.array(gridCellSchema),
  markers: weekMarkersSchema.default({ guardrail: null, guardrailCount: 0, drift: null, shipped: 0, needClosure: 0, planHitRate: null }),
});
export type GridWeek = z.infer<typeof gridWeekSchema>;
export const lensAvailabilitySchema = z.object({ rating: z.boolean(), area: z.boolean(), meeting: z.boolean(), evidence: z.boolean(), plan: z.boolean() });
export const gridV2Schema = z.object({
  today: z.string(),
  currentWeek: z.string(),
  weeks: z.array(gridWeekSchema),
  status: worklogStatusSchema,
  areas: z.array(areaSnapshotSchema),
  lensAvailability: lensAvailabilitySchema,
  timeZone: z.string(),
  workdayHours: z.number(),
});
export type GridV2 = z.infer<typeof gridV2Schema>;
export type WorklogGrid = GridV2;

// ─── 3. Connectors ──────────────────────────────────────────────────────────
export const connectorStateSchema = z.object({
  available: z.boolean().nullable(),
  via: z.string().nullable(),
  account: z.string().nullable(),
  note: z.string().nullable(),
  mode: z.enum(["gh", "mcp"]).nullable().default(null),
});
export const connectorCheckSchema = z.object({
  checkedAt: z.string(),
  hostId: z.string(),
  hostName: z.string(),
  model: z.string().nullable(),
  sources: z.record(z.string(), connectorStateSchema),
});
export type ConnectorCheck = z.infer<typeof connectorCheckSchema>;

// ─── 4. Time: targets and drift (percentage points, signed) ─────────────────
export const allocationTargetsSchema = z.object({
  version: z.literal(1),
  frameworkId: slug,
  /** percent, must sum to 100 (+-1) */
  targets: z.record(slug, z.number().min(0).max(100)),
  windowWeeks: z.number().int().min(1).max(12).default(4),
  /** score = max |drift| in percentage points */
  thresholds: z.object({ watch: z.number().default(10), off: z.number().default(20) }),
  updatedAt: z.string(),
});
export type AllocationTargets = z.infer<typeof allocationTargetsSchema>;
export const weekMixSchema = z.object({
  week: weekStr,
  daysCounted: z.number(),
  actual: z.record(slug, z.number()),
  scorecard: z.record(slug, scorecardStatus),
  /** max |drift| in pp against the targets, null without targets or data */
  drift: z.number().nullable(),
});
export type WeekMix = z.infer<typeof weekMixSchema>;
export const driftSnapshotSchema = z.object({
  week: weekStr,
  windowWeeks: z.number(),
  actual: z.record(slug, z.number()),
  target: z.record(slug, z.number()),
  /** signed pp per area: actual% - target%, rounded to 0.1 */
  perArea: z.record(slug, z.number()),
  /** max |perArea| */
  score: z.number(),
  status: z.enum(["aligned", "watch", "off"]),
  biggestOver: slug.nullable(),
  biggestUnder: slug.nullable(),
  computedAt: z.string(),
});
export type DriftSnapshot = z.infer<typeof driftSnapshotSchema>;

// ─── 5. Guardrails ──────────────────────────────────────────────────────────
export const guardrailRuleSchema = z.object({
  id: z.string(),
  enabled: z.boolean().default(true),
  severity,
  rule: z.discriminatedUnion("type", [
    z.object({ type: z.literal("meeting_load"), maxPct: z.number().min(1).max(100), weeks: z.number().int().min(1).max(8).default(1) }),
    z.object({ type: z.literal("area_missed"), area: slug.nullable(), weeks: z.number().int().min(1).max(12) }),
    z.object({ type: z.literal("area_absent"), areas: z.array(slug).min(1), weeks: z.number().int().min(1).max(12) }),
    z.object({ type: z.literal("open_asks_age"), weeks: z.number().int().min(1).max(12) }),
    z.object({ type: z.literal("coverage_failure"), source: z.string().nullable(), daysPerWeek: z.number().int().min(1).max(5) }),
    z.object({ type: z.literal("drift_over"), score: z.number().min(1).max(100) }),
    z.object({ type: z.literal("plan_hit_below"), pct: z.number().min(0).max(100), weeks: z.number().int().min(1).max(8) }),
    z.object({ type: z.literal("area_share_min"), area: slug, minPct: z.number().min(0).max(100), weeks: z.number().int().min(1).max(12) }),
    z.object({ type: z.literal("area_share_max"), area: slug, maxPct: z.number().min(0).max(100), weeks: z.number().int().min(1).max(12) }),
    z.object({ type: z.literal("wip_limit"), max: z.number().int().min(1).max(50) }),
    z.object({ type: z.literal("closure_rate"), minPct: z.number().min(0).max(100), weeks: z.number().int().min(1).max(26) }),
  ]),
});
export type GuardrailRule = z.infer<typeof guardrailRuleSchema>;
export const guardrailResultSchema = z.object({
  /** `${ruleId}:${week}` */
  id: z.string(),
  ruleId: z.string(),
  week: weekStr,
  severity,
  title: z.string(),
  detail: z.string(),
  evidence: z.array(evidenceRef).default([]),
  firstBreachedWeek: weekStr,
  state: z.enum(["open", "acknowledged", "resolved"]),
  ackNote: z.string().nullable(),
  at: z.string(),
});
export type GuardrailResult = z.infer<typeof guardrailResultSchema>;

// ─── 6. Confirm / override ──────────────────────────────────────────────────
export const overrideTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("day"), date: dateStr }),
  z.object({ type: z.literal("week"), week: weekStr }),
  z.object({ type: z.literal("scorecard"), week: weekStr, area: slug }),
]);
export type OverrideTarget = z.infer<typeof overrideTargetSchema>;
export const overrideSchema = z.object({
  id: z.string(),
  target: overrideTargetSchema,
  decision: z.enum(["confirmed", "overridden"]),
  /** rating or scorecard status at review time: the original is kept here */
  aiValue: z.string(),
  /** equals aiValue when confirmed */
  value: z.string(),
  note: z.string().max(300).nullable(),
  aiChangedSince: z.boolean().default(false),
  at: z.string(),
});
export type Override = z.infer<typeof overrideSchema>;
export const overrideStatsSchema = z.object({
  reviewed: z.number(),
  confirmed: z.number(),
  overridden: z.number(),
  agreementRate: z.number().nullable(),
  raised: z.number(),
  lowered: z.number(),
  unreviewed: z.number(),
});
export type OverrideStats = z.infer<typeof overrideStatsSchema>;

// ─── 7. Threads and closure ─────────────────────────────────────────────────
export const threadStatusSchema = z.enum(["active", "at_risk", "shipped", "closed", "stale", "dropped"]);
export const threadSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** "jira:ABC-12", "pr:o/r#5", "doc:<host>/<id>" */
  keys: z.array(z.string()),
  weeks: z.array(z.object({ week: weekStr, state: z.enum(["in_progress", "shipped"]), text: z.string(), evidenceIds: z.array(z.string()) })),
  firstWeek: weekStr,
  lastWeek: weekStr,
  status: threadStatusSchema,
  droppedReason: z.string().nullable().default(null),
  links: z.array(z.string()).default([]).transform((l) => l.filter(isHttpsUrl)),
  hidden: z.boolean().default(false),
});
export type Thread = z.infer<typeof threadSchema>;
export const threadEditSchema = z.object({
  threadId: z.string(),
  title: z.string().max(120).nullable(),
  mergeInto: z.string().nullable(),
  hidden: z.boolean().nullable(),
  extraKeys: z.array(z.string()).default([]),
  /** Dropping a thread needs a short reason. Null leaves the thread as it is. */
  drop: z.object({ reason: z.string().min(1).max(200) }).nullable().default(null),
});
export type ThreadEdit = z.infer<typeof threadEditSchema>;
export const closureNoteSchema = z.object({
  threadId: z.string(),
  outcome: z.enum(["better", "as_expected", "worse", "mixed"]),
  expectation: z.string().max(400),
  result: z.string().max(400),
  learnings: z.string().max(800),
  /** Optional one-line impact of the outcome. */
  impact: z.string().max(200).optional(),
  /** "agent" = drafted by the week judge; a user edit sets it to "user". */
  source: z.enum(["agent", "user"]).default("user"),
  at: z.string(),
});
export type ClosureNote = z.infer<typeof closureNoteSchema>;

// ─── 8. Invisible work ──────────────────────────────────────────────────────
export const ghostClusterSchema = z.object({
  id: z.string(),
  bucket: z.string(),
  label: z.string(),
  items: z.array(evidenceRef.extend({ week: weekStr, kind: z.string(), what: z.string() })),
  weeks: z.array(weekStr),
  count: z.number(),
  state: z.enum(["new", "claimed", "dismissed"]),
  claimedAs: z.enum(["note", "raise"]).nullable(),
  claimedWeek: weekStr.nullable(),
});
export type GhostCluster = z.infer<typeof ghostClusterSchema>;
export const weekAddendaSchema = z.object({
  week: weekStr,
  myNotes: z.string().max(8000).default(""),
  claimedWork: z.array(claimSchema).default([]),
  raiseWithManager: z.array(claimSchema).default([]),
  updatedAt: z.string(),
});
export type WeekAddenda = z.infer<typeof weekAddendaSchema>;

// ─── 9. Review packet ───────────────────────────────────────────────────────
export const packetClaim = z.object({ week: weekStr, text: z.string(), evidence: z.array(evidenceRef) });
export const packetGoalSchema = z.object({
  goalId: z.string(),
  text: z.string(),
  area: slug.nullable(),
  /** One entry per judged week in the range that reported on this goal. */
  weeks: z.array(z.object({ week: weekStr, status: z.enum(["advanced", "no_movement"]), evidence: z.array(evidenceRef) })),
  advancedWeeks: z.number(),
  judgedWeeks: z.number(),
});
export const packetUncreditedSchema = z.object({
  id: z.string(),
  label: z.string(),
  count: z.number(),
  weeks: z.array(weekStr),
  items: z.array(evidenceRef.extend({ week: weekStr, kind: z.string(), what: z.string() })),
});
export const reviewPacketSchema = z.object({
  from: dateStr,
  to: dateStr,
  generatedAt: z.string(),
  frameworkId: slug,
  weeks: z.array(weekStr),
  ratingDistribution: z.record(z.string(), z.number()),
  weekRatings: z.array(z.object({ week: weekStr, rating: z.string(), final: z.boolean() })),
  heatmap: z.array(
    z.object({
      area: slug,
      label: z.string(),
      cells: z.array(z.object({ week: weekStr, status: scorecardStatus.nullable(), overridden: z.boolean() })),
    }),
  ),
  shipped: z.array(z.object({ title: z.string(), threadId: z.string().nullable(), weeks: z.array(weekStr), evidence: z.array(evidenceRef), closure: closureNoteSchema.nullable() })),
  decisions: z.array(packetClaim),
  recognition: z.array(packetClaim),
  helpGiven: z.array(packetClaim),
  claimedWork: z.array(packetClaim),
  mix: z.array(weekMixSchema),
  drift: driftSnapshotSchema.nullable(),
  plan: z.object({ hitRate: z.number().nullable(), carriedOver: z.array(z.string()) }),
  overrides: overrideStatsSchema,
  coverageGaps: z.array(z.string()),
  narrative: z.string().nullable(),
  /** Goal progress over the range, from the week judge's goalProgress (week.ext.goals). */
  goals: z.array(packetGoalSchema).default([]),
  /** Radar clusters still `new` (neither claimed nor dismissed): work no weekly summary mentioned. */
  uncreditedWork: z.array(packetUncreditedSchema).default([]),
});
export type ReviewPacket = z.infer<typeof reviewPacketSchema>;

// ─── 10. Setup (zero-config), profile and goals ─────────────────────────────
export const MAX_GOAL = 200;
export const MAX_ROLE_CARD = 20000;
const basisText = z.string().max(200);
/** Why the agent set a field: "from role card §2", "recurring 1:1 on the calendar". Keyed by field name. */
const basisMap = z.record(z.string(), basisText).default({});

/** Who the user is, as the agent sees them in transcripts, chat and trackers. Passed to every capture job. */
export const identitySchema = z.object({
  name: z.string().min(1).max(80),
  email: z.string().max(120).nullable().default(null),
  /** Per-source handles discovered by the connector check or typed by the user: slack, github, jira, ... */
  handles: z.record(z.string(), z.string().max(80)).default({}),
});
export type Identity = z.infer<typeof identitySchema>;

export const roleCardSchema = z.object({
  kind: z.enum(["text", "note", "url"]),
  value: z.string().max(MAX_ROLE_CARD),
  title: z.string().max(120).optional(),
});
export type RoleCard = z.infer<typeof roleCardSchema>;

/** Facts the synthesis inferred; Settings shows each with its basis. */
export const inferredSchema = z.object({
  level: z.string().max(60).nullable().default(null),
  scope: z.string().max(400).nullable().default(null),
  /** First name only. Null when no recurring 1:1 was found. */
  managerName: z.string().max(60).nullable().default(null),
  reviewCadence: z.string().max(120).nullable().default(null),
  basis: basisMap,
  /**
   * Provenance: what the user has taken over. Fact names are set when the user changes that fact in Settings; the
   * structures ("framework", "targets", "guardrails") are set when a re-run kept the user's version. A re-run never
   * replaces anything listed here. Maintained by the server; a client cannot remove an entry.
   */
  userEdited: z.array(z.enum(["level", "scope", "managerName", "reviewCadence", "framework", "targets", "guardrails"])).max(7).optional(),
});
export type Inferred = z.infer<typeof inferredSchema>;

/** Record `profile`/`active`: the only things the user supplies, plus what the agent figured out. */
export const profileSchema = z.object({
  version: z.literal(1).default(1),
  identity: identitySchema,
  roleCard: roleCardSchema.nullable().default(null),
  inferred: inferredSchema.default({ level: null, scope: null, managerName: null, reviewCadence: null, basis: {} }),
  /** ISO time the agent last finished setup; null before the first. */
  setupAt: z.string().nullable().default(null),
});
export type Profile = z.infer<typeof profileSchema>;

export const goalTaskSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  text: z.string().max(200),
  /** Issue key or https URL. */
  ref: z.string().max(500).nullable(),
  source: z.enum(["backlog", "agent", "user"]),
  status: z.enum(["open", "in_progress", "done", "dropped"]),
  updatedWeek: weekStr.nullable(),
  evidenceIds: z.array(z.string()).default([]),
});
export type GoalTask = z.infer<typeof goalTaskSchema>;
export const goalSchema = z.object({
  id: z.string(),
  text: z.string().min(1).max(MAX_GOAL),
  area: slug.nullable().default(null),
  source: z.enum(["setup", "agent", "user"]),
  basis: basisText.nullable().default(null),
  createdAt: z.string(),
  tasks: z.array(goalTaskSchema).max(8).default([]),
  /** Refs (or, for a task without one, its text) of tasks the user dropped and that were capped away; a refresh never re-adds them. Not part of the 8-task cap. */
  droppedRefs: z.array(z.string().max(500)).max(20).default([]),
});
export type Goal = z.infer<typeof goalSchema>;
/** Record `goals`/`active`. */
export const goalsSchema = z.object({
  version: z.literal(1).default(1),
  goals: z.array(goalSchema).max(8),
  tasksRefreshedAt: z.string().nullable().default(null),
});
export type Goals = z.infer<typeof goalsSchema>;

/** What the synthesis job produces and apply writes. */
export const setupProposalSchema = z.object({
  framework: roleFrameworkSchema,
  /** percent per area key, summing to 100 (+-1) */
  targets: z.record(slug, z.number().min(0).max(100)),
  guardrails: z.array(guardrailRuleSchema).max(12),
  goals: z.array(z.object({ text: z.string().min(1).max(MAX_GOAL), area: slug.nullable().default(null), basis: basisText.nullable().default(null) })).min(2).max(5),
  inferred: inferredSchema,
  /** Basis for the larger pieces: `framework`, `targets`, `guardrails`, `goals`. */
  basis: basisMap,
});
export type SetupProposal = z.infer<typeof setupProposalSchema>;
export const setupStatusSchema = z.enum(["idle", "running", "failed", "applied"]);
export type SetupStatus = z.infer<typeof setupStatusSchema>;
/** Record `setup`/`state`: progress of the last "figure it out" run. */
export const setupStateSchema = z.object({
  status: setupStatusSchema,
  proposal: setupProposalSchema.nullable(),
  error: z.string().nullable(),
  /** Parts of the last apply where the user's own edits were kept over the new proposal ("work split", "guardrails", …). */
  kept: z.array(z.string()).default([]),
  at: z.string(),
});
export type SetupState = z.infer<typeof setupStateSchema>;

// ─── shared small types ─────────────────────────────────────────────────────
/** An evidence entry before the server assigns its id. */
export type RawEntry = Omit<EvidenceEntry, "id" | "area"> & { area?: string | null };
/** One source's captured result for one day. */
export interface SourcePart {
  coverage: Coverage;
  entries: RawEntry[];
}
export const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
