/** service.ts — loads the inputs, builds the threads and stores the derived record (kind `threads`, id `derived`). */
import { z } from "zod";
import { isoWeekOf, localToday } from "../../engine/dates";
import type { FeatureCtx } from "../../engine/extensions";
import { KIND } from "../../storage/port";
import { closureNoteSchema, threadEditSchema, threadSchema, workWeekSchema, type ClosureNote, type Thread, type ThreadEdit } from "../../types";
import { buildThreadsDetailed, needClosureIds, type BuiltThreads } from "./build";

export const DERIVED_ID = "derived";
export const derivedThreadsSchema = z.object({ builtAt: z.string(), todayWeek: z.string(), threads: z.array(threadSchema), needClosure: z.array(z.string()) });
export type DerivedThreads = z.infer<typeof derivedThreadsSchema>;

export const todayWeekOf = (ctx: FeatureCtx): string => isoWeekOf(localToday(ctx.now(), ctx.settings().timeZone));

export interface ThreadInputs {
  edits: ThreadEdit[];
  closures: ClosureNote[];
}

export async function loadInputs(ctx: FeatureCtx): Promise<ThreadInputs> {
  const [edits, closures] = await Promise.all([ctx.store.list(KIND.threadEdit, threadEditSchema), ctx.store.list(KIND.closure, closureNoteSchema)]);
  return { edits: edits.map((r) => r.value), closures: closures.map((r) => r.value) };
}

/** Build from every stored week record. */
export async function buildAll(ctx: FeatureCtx, inputs?: ThreadInputs): Promise<BuiltThreads & ThreadInputs & { todayWeek: string }> {
  const [weeks, loaded] = await Promise.all([ctx.store.list(KIND.week, workWeekSchema), inputs ?? loadInputs(ctx)]);
  const todayWeek = todayWeekOf(ctx);
  const built = buildThreadsDetailed(weeks.map((r) => r.value), loaded.edits, loaded.closures, todayWeek);
  return { ...built, ...loaded, todayWeek };
}

/** Rebuild and store the derived record; returns what was stored. */
export async function rebuildAndStore(ctx: FeatureCtx): Promise<DerivedThreads> {
  const { threads, todayWeek } = await buildAll(ctx);
  const derived: DerivedThreads = { builtAt: ctx.now().toISOString(), todayWeek, threads, needClosure: needClosureIds(threads, todayWeek) };
  await ctx.store.set(KIND.threads, DERIVED_ID, derived);
  ctx.publish();
  return derived;
}

export const readDerived = (ctx: FeatureCtx): Promise<DerivedThreads | null> => ctx.store.get(KIND.threads, DERIVED_ID, derivedThreadsSchema);

export type { Thread };
