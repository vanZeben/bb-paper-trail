/**
 * contract.ts — every RPC (plan section 5). Single owner: the scaffold. All run-type methods return at once;
 * progress arrives on the realtime channel (lib/meta.ts CHANNEL) and through `run.status`.
 * The app must import this module as a type only (it pulls in the server SDK).
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  allocationTargetsSchema, closureNoteSchema, connectorCheckSchema, dateStr, dayRatingSchema, driftSnapshotSchema, frameworkProposalSchema,
  goalsSchema, profileSchema, setupProposalSchema, setupStatusSchema,
  ghostClusterSchema, gridV2Schema, guardrailResultSchema, guardrailRuleSchema, MAX_BACKFILL_WEEKS, ok, overrideSchema, overrideStatsSchema, overrideTargetSchema,
  planAccuracySchema, planItemSchema, reviewPacketSchema, roleFrameworkSchema, threadEditSchema, threadSchema, weekAddendaSchema, weekMixSchema, weekPlanSchema, weekStr,
  slug, workDaySchema, workWeekSchema, worklogStatusSchema,
} from "./types";

const none = z.null();
const weeksIn = (def: number, min = 1, max = 52) => z.object({ weeks: z.number().int().min(min).max(max).default(def) });
const range = z.object({ from: dateStr, to: dateStr });
const markdown = z.object({ markdown: z.string(), filename: z.string() });
/** Result of a data import; `migrate.status` adds the time of the last import (null before the first) and whether one is running. */
const importSummary = z.object({
  imported: z.object({ days: z.number(), weeks: z.number(), records: z.number() }),
  skipped: z.number(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  at: z.string().nullable(),
});

export const rpcContract = defineRpcContract({
  "diag.ping": { input: none, output: z.object({ ok: z.boolean(), hostId: z.string().optional(), hostName: z.string().optional(), reply: z.string().optional(), error: z.string().optional() }) },

  "grid.get": { input: z.object({ weeks: z.number().int().min(4).max(52).default(36) }), output: gridV2Schema },
  "day.get": {
    input: z.object({ date: dateStr }),
    output: z.object({ day: workDaySchema.nullable(), override: overrideSchema.nullable(), effectiveRating: dayRatingSchema.shape.rating.nullable(), weekFinal: z.boolean() }),
  },
  "week.get": {
    input: z.object({ week: weekStr }),
    output: z.object({
      week: workWeekSchema.nullable(),
      overrides: z.array(overrideSchema),
      addenda: weekAddendaSchema,
      plan: weekPlanSchema.nullable(),
      violations: z.array(guardrailResultSchema),
      mix: weekMixSchema.nullable(),
    }),
  },
  "week.markdown": { input: z.object({ week: weekStr }), output: markdown },
  "run.start": {
    input: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("day"), date: dateStr }),
      z.object({ kind: z.literal("week"), week: weekStr, recapture: z.boolean().default(false) }),
      z.object({ kind: z.literal("backfill"), weeks: z.number().int().min(1).max(MAX_BACKFILL_WEEKS).default(4), force: z.boolean().default(false) }),
      z.object({ kind: z.literal("fill_gaps"), weeks: z.number().int().min(1).max(MAX_BACKFILL_WEEKS).default(4) }),
    ]),
    output: ok,
  },
  "run.status": { input: none, output: worklogStatusSchema },

  // connectors + onboarding (B1)
  "connectors.get": {
    input: none,
    output: z.object({ check: connectorCheckSchema.nullable(), stale: z.boolean(), hosts: z.array(z.object({ id: z.string(), name: z.string(), connected: z.boolean() })) }),
  },
  "connectors.check": { input: none, output: ok },
  "onboarding.get": {
    input: none,
    output: z.object({ completed: z.boolean(), steps: z.object({ connectors: z.boolean(), framework: z.boolean(), targets: z.boolean(), firstRun: z.boolean() }) }),
  },
  "onboarding.complete": { input: none, output: ok },
  "framework.get": { input: none, output: z.object({ framework: roleFrameworkSchema, presets: z.array(z.object({ id: z.string(), name: z.string() })) }) },
  "framework.set": { input: z.object({ framework: roleFrameworkSchema }), output: z.object({ framework: roleFrameworkSchema }) },
  "framework.usePreset": { input: z.object({ id: z.string() }), output: z.object({ framework: roleFrameworkSchema }) },
  "framework.importDoc": { input: z.object({ ref: z.object({ kind: z.enum(["text", "url", "note"]), value: z.string().max(20000) }) }), output: ok },
  "framework.proposal": { input: none, output: frameworkProposalSchema.nullable() },

  // zero-config setup + goals. answer stores identity and role card; synthesize figures out the rest and applies it.
  "setup.get": { input: none, output: z.object({ profile: profileSchema.nullable(), proposal: setupProposalSchema.nullable(), status: setupStatusSchema, error: z.string().nullable(), kept: z.array(z.string()) }) },
  "setup.answer": { input: z.object({ profile: profileSchema }), output: ok },
  "setup.synthesize": { input: none, output: ok },
  "setup.apply": { input: none, output: ok },
  "goals.get": { input: none, output: goalsSchema },
  "goals.set": { input: z.object({ goals: goalsSchema.shape.goals }), output: goalsSchema },
  "goals.refresh": { input: none, output: ok },

  // time + drift (B3)
  "targets.get": { input: none, output: allocationTargetsSchema.nullable() },
  "targets.set": { input: z.object({ targets: allocationTargetsSchema }), output: allocationTargetsSchema },
  "drift.get": {
    input: weeksIn(12, 4),
    output: z.object({ mix: z.array(weekMixSchema), snapshot: driftSnapshotSchema.nullable(), method: z.enum(["day_areas", "evidence"]) }),
  },

  // guardrails (B3)
  "guardrails.rules.get": { input: none, output: z.object({ rules: z.array(guardrailRuleSchema) }) },
  "guardrails.rules.set": { input: z.object({ rules: z.array(guardrailRuleSchema) }), output: z.object({ rules: z.array(guardrailRuleSchema) }) },
  "guardrails.results": {
    input: z.object({ weeks: z.number().int().min(1).max(52).default(12), state: z.enum(["open", "acknowledged", "resolved"]).optional() }),
    output: z.object({ results: z.array(guardrailResultSchema) }),
  },
  "guardrails.ack": { input: z.object({ id: z.string(), note: z.string().max(300) }), output: ok },

  // overrides (B2)
  "override.set": { input: z.object({ target: overrideTargetSchema, value: z.string().nullable(), note: z.string().max(300).nullable() }), output: z.object({ override: overrideSchema }) },
  "override.clear": { input: z.object({ target: overrideTargetSchema }), output: ok },
  "override.stats": { input: weeksIn(12), output: overrideStatsSchema },

  // plan (B4)
  "plan.get": { input: z.object({ week: weekStr }), output: weekPlanSchema },
  "plan.set": {
    input: z.object({ week: weekStr, items: z.array(z.object({ id: z.string().optional(), text: z.string().min(1).max(200), area: slug.nullable().optional() })).max(7) }),
    output: weekPlanSchema,
  },
  "plan.push": { input: z.object({ week: weekStr, items: z.array(z.object({ text: z.string().min(1).max(200), externalRef: z.string() })).max(7) }), output: ok },
  "plan.now": { input: z.object({ week: weekStr.optional() }), output: ok },
  "plan.accuracy": { input: weeksIn(12), output: planAccuracySchema },
  "plan.stats": {
    input: weeksIn(12),
    output: z.object({
      hitRate: z.number().nullable(),
      byWeek: z.array(z.object({ week: weekStr, hitRate: z.number().nullable() })),
      carriedOver: z.array(z.object({ text: z.string(), carryCount: z.number(), firstWeek: weekStr })),
    }),
  },

  // threads + closure (B4)
  "threads.list": {
    input: weeksIn(36),
    output: z.object({ threads: z.array(threadSchema), closures: z.array(closureNoteSchema), needClosure: z.array(z.string()) }),
  },
  "threads.edit": { input: threadEditSchema, output: ok },
  "closure.set": { input: closureNoteSchema.omit({ at: true, source: true }), output: ok },

  // invisible work (B5)
  "ghost.list": { input: weeksIn(8), output: z.object({ clusters: z.array(ghostClusterSchema) }) },
  "ghost.claim": { input: z.object({ id: z.string(), as: z.enum(["note", "raise"]), week: weekStr, text: z.string().max(300) }), output: ok },
  "ghost.dismiss": { input: z.object({ id: z.string() }), output: ok },
  "addenda.set": { input: z.object({ week: weekStr, myNotes: z.string().max(8000) }), output: ok },

  // review packet (B5)
  "packet.build": { input: range, output: reviewPacketSchema.extend({ narrativeStatus: z.enum(["idle", "running", "ready", "failed"]).optional() }) },
  "packet.markdown": { input: range.extend({ includeNarrative: z.boolean().default(false) }), output: markdown },
  "packet.narrative.start": { input: range, output: ok },
  "packet.writeNote": { input: range.extend({ path: z.string().min(1).max(300) }), output: ok },

  // data bundles: import, export and the last import's summary
  "migrate.status": { input: none, output: importSummary.extend({ running: z.boolean() }) },
  "data.export": { input: z.object({ from: dateStr.optional(), to: dateStr.optional() }), output: z.object({ bundle: z.unknown() }) },
  "data.import": { input: z.object({ bundle: z.unknown(), applyFramework: z.boolean().default(false) }), output: importSummary.omit({ at: true }) },
});

export type RpcContract = typeof rpcContract;
