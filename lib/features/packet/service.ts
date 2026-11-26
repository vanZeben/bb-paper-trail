/** service.ts — packet store access: gather the records for a range, build, narrative and note jobs. */
import { z } from "zod";
import type { FeatureCtx } from "../../engine/extensions";
import { KIND } from "../../storage/port";
import {
  closureNoteSchema, connectorCheckSchema, driftSnapshotSchema, ghostClusterSchema, goalsSchema, overrideSchema, threadSchema, weekAddendaSchema, weekMixSchema, weekPlanSchema,
  workDaySchema, workWeekSchema, type ReviewPacket,
} from "../../types";
import { buildPacket, weeksInRange, type PacketRange } from "./build";
import { packetMarkdown, packetFilename } from "./markdown";
import { narrativeJob } from "./narrative";
import { resolveNotePath, vaultUnavailable, writeNoteJob } from "./note";

export const packetCacheSchema = z.object({ from: z.string(), to: z.string(), narrative: z.string().nullable(), at: z.string(), failed: z.boolean().optional() });
export type NarrativeStatus = "idle" | "running" | "ready" | "failed";
const threadsSchema = z.union([z.array(threadSchema), z.object({ threads: z.array(threadSchema) }).transform((v) => v.threads)]);
export const packetCacheId = (r: PacketRange): string => `${r.from}_${r.to}`;

export async function loadPacket(ctx: FeatureCtx, range: PacketRange): Promise<ReviewPacket> {
  if (range.from > range.to) throw new Error("`from` must not be after `to`");
  const weeks = weeksInRange(range);
  const wb = { from: weeks[0]!, to: weeks[weeks.length - 1]! };
  const { store } = ctx;
  const [framework, days, wks, overrides, addenda, threads, closures, plans, mix, drifts, cache, goals, ghosts] = await Promise.all([
    ctx.framework(),
    store.list(KIND.day, workDaySchema, range),
    store.list(KIND.week, workWeekSchema, wb),
    store.list(KIND.override, overrideSchema),
    store.list(KIND.addenda, weekAddendaSchema, wb),
    store.get(KIND.threads, "derived", threadsSchema),
    store.list(KIND.closure, closureNoteSchema),
    store.list(KIND.plan, weekPlanSchema, wb),
    store.list(KIND.mix, weekMixSchema, wb),
    store.list(KIND.drift, driftSnapshotSchema, wb),
    store.get(KIND.packet, packetCacheId(range), packetCacheSchema),
    store.get(KIND.goals, "active", goalsSchema),
    store.list(KIND.ghost, ghostClusterSchema),
  ]);
  return buildPacket(range, {
    frameworkId: framework.id,
    areas: framework.areas.map((a) => ({ key: a.key, label: a.label })),
    days: days.map((r) => r.value),
    weeks: wks.map((r) => r.value),
    overrides: overrides.map((r) => r.value),
    addenda: addenda.map((r) => r.value),
    threads: threads === null || threads.length === 0 ? null : threads,
    closures: closures.map((r) => r.value),
    plans: plans.map((r) => r.value),
    mix: mix.map((r) => r.value),
    drifts: drifts.map((r) => r.value),
    generatedAt: ctx.now().toISOString(),
    narrative: cache?.narrative ?? null,
    goals: goals?.goals ?? [],
    ghosts: ghosts.map((r) => r.value),
  });
}

export async function packetDoc(ctx: FeatureCtx, range: PacketRange, includeNarrative: boolean): Promise<{ markdown: string; filename: string }> {
  const packet = await loadPacket(ctx, range);
  return { markdown: packetMarkdown(packet, { includeNarrative }), filename: packetFilename(range.from, range.to) };
}

const running = new Set<string>();

/** idle: never drafted; running: a draft job is in flight; failed: the last attempt failed; ready: a narrative is cached. */
export async function narrativeStatus(ctx: FeatureCtx, range: PacketRange): Promise<NarrativeStatus> {
  const id = packetCacheId(range);
  if (running.has(id)) return "running";
  const cache = await ctx.store.get(KIND.packet, id, packetCacheSchema);
  if (cache?.failed === true) return "failed";
  return cache?.narrative != null ? "ready" : "idle";
}

/** Starts the narrative job and returns at once; the result lands in the `packet` record and is announced on the channel. */
export function startNarrative(ctx: FeatureCtx, range: PacketRange): void {
  const id = packetCacheId(range);
  if (running.has(id)) return;
  running.add(id);
  void (async () => {
    try {
      const packet = await loadPacket(ctx, range);
      const s = ctx.settings();
      const narrative = await ctx.runner.runJob({ ...narrativeJob(packet), tools: "none" }, { model: s.judgeModel || undefined, timeoutMs: s.judgeTimeoutMinutes * 60_000 });
      await ctx.store.set(KIND.packet, id, { from: range.from, to: range.to, narrative, at: ctx.now().toISOString() });
    } catch (cause) {
      const previous = await ctx.store.get(KIND.packet, id, packetCacheSchema).catch(() => null);
      await ctx.store.set(KIND.packet, id, { from: range.from, to: range.to, narrative: previous?.narrative ?? null, at: ctx.now().toISOString(), failed: true }).catch(() => undefined);
      ctx.log.warn(`packet narrative ${id} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      running.delete(id);
      ctx.publish();
    }
  })();
}

export async function writeNote(ctx: FeatureCtx, range: PacketRange, path: string): Promise<void> {
  const s = ctx.settings();
  const clean = resolveNotePath(path, s.notesFolder);
  const check = await ctx.store.get(KIND.connectors, "latest", connectorCheckSchema);
  const refused = vaultUnavailable(check, s.enabledSources.includes("vault"));
  if (refused !== null) throw new Error(refused);
  const { markdown } = await packetDoc(ctx, range, true);
  await ctx.runner.runJob(writeNoteJob(clean, markdown), { model: s.captureModel || undefined, timeoutMs: s.captureTimeoutMinutes * 60_000, retries: 0 });
}

