/**
 * service.ts — the ghost feature's store access: rebuild clusters into `ghost` records, list, claim, dismiss, and the
 * addenda record. Pure logic is in radar.ts.
 */
import { z } from "zod";
import { addDays, isoWeekOf, localToday, weekMonday } from "../../engine/dates";
import type { FeatureCtx } from "../../engine/extensions";
import { KIND } from "../../storage/port";
import {
  ghostClusterSchema, threadSchema, weekAddendaSchema, weekPlanSchema, workDaySchema, workWeekSchema,
  type GhostCluster, type Thread, type WeekAddenda,
} from "../../types";
import { buildGhosts } from "./radar";

/** How far back a rebuild looks. */
export const LOOKBACK_WEEKS = 26;
const threadsSchema = z.union([z.array(threadSchema), z.object({ threads: z.array(threadSchema) }).transform((v) => v.threads)]);

async function readThreads(ctx: FeatureCtx): Promise<Thread[]> {
  return (await ctx.store.get(KIND.threads, "derived", threadsSchema)) ?? [];
}

/** Recompute the clusters and write them; returns the stored set. */
export async function rebuildGhosts(ctx: FeatureCtx, throughWeek: string): Promise<GhostCluster[]> {
  const from = addDays(weekMonday(throughWeek), -7 * LOOKBACK_WEEKS);
  const to = addDays(weekMonday(throughWeek), 6);
  const fromWeek = isoWeekOf(from);
  const [days, weeks, plans, threads, existing] = await Promise.all([
    ctx.store.list(KIND.day, workDaySchema, { from, to }),
    ctx.store.list(KIND.week, workWeekSchema, { from: fromWeek, to: throughWeek }),
    ctx.store.list(KIND.plan, weekPlanSchema, { from: fromWeek, to: throughWeek }),
    readThreads(ctx),
    ctx.store.list(KIND.ghost, ghostClusterSchema),
  ]);
  const { clusters, remove } = buildGhosts(
    { days: days.map((r) => r.value), weeks: weeks.map((r) => r.value), plans: plans.map((r) => r.value), threads },
    existing.map((r) => r.value),
  );
  for (const id of remove) await ctx.store.delete(KIND.ghost, id);
  for (const c of clusters) await ctx.store.set(KIND.ghost, c.id, c);
  return clusters;
}

export async function listGhosts(ctx: FeatureCtx, weeks: number): Promise<GhostCluster[]> {
  const current = isoWeekOf(localToday(ctx.now(), ctx.settings().timeZone));
  let rows = await ctx.store.list(KIND.ghost, ghostClusterSchema);
  if (rows.length === 0) {
    await rebuildGhosts(ctx, current);
    rows = await ctx.store.list(KIND.ghost, ghostClusterSchema);
  }
  const earliest = isoWeekOf(addDays(weekMonday(current), -7 * (weeks - 1)));
  return rows
    .map((r) => r.value)
    .filter((c) => c.weeks.some((w) => w >= earliest))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

const emptyAddenda = (week: string, now: string): WeekAddenda => weekAddendaSchema.parse({ week, updatedAt: now });

export async function claimGhost(ctx: FeatureCtx, input: { id: string; as: "note" | "raise"; week: string; text: string }): Promise<void> {
  const cluster = await ctx.store.get(KIND.ghost, input.id, ghostClusterSchema);
  if (cluster === null) throw new Error(`unknown cluster: ${input.id}`);
  if (cluster.state === "claimed") throw new Error("this cluster is already claimed");
  const now = ctx.now().toISOString();
  const addenda = (await ctx.store.get(KIND.addenda, input.week, weekAddendaSchema)) ?? emptyAddenda(input.week, now);
  const claim = { text: input.text.trim() === "" ? cluster.label : input.text.trim(), evidenceIds: [...new Set(cluster.items.map((i) => i.id))] };
  const next: WeekAddenda = {
    ...addenda,
    claimedWork: input.as === "note" ? [...addenda.claimedWork, claim] : addenda.claimedWork,
    raiseWithManager: input.as === "raise" ? [...addenda.raiseWithManager, claim] : addenda.raiseWithManager,
    updatedAt: now,
  };
  await ctx.store.set(KIND.addenda, input.week, next);
  await ctx.store.set(KIND.ghost, cluster.id, { ...cluster, state: "claimed", claimedAs: input.as, claimedWeek: input.week });
  ctx.publish();
}

export async function dismissGhost(ctx: FeatureCtx, id: string): Promise<void> {
  const cluster = await ctx.store.get(KIND.ghost, id, ghostClusterSchema);
  if (cluster === null) throw new Error(`unknown cluster: ${id}`);
  await ctx.store.set(KIND.ghost, id, { ...cluster, state: "dismissed" });
  ctx.publish();
}

export async function setNotes(ctx: FeatureCtx, week: string, myNotes: string): Promise<void> {
  const now = ctx.now().toISOString();
  const addenda = (await ctx.store.get(KIND.addenda, week, weekAddendaSchema)) ?? emptyAddenda(week, now);
  await ctx.store.set(KIND.addenda, week, { ...addenda, myNotes, updatedAt: now });
  ctx.publish();
}
