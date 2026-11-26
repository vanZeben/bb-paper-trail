/**
 * threads — derived work threads across weeks, with a lifecycle and closure notes.
 * Records: `threads` id "derived" (rebuilt after every week save and every edit), `thread-edit` id = threadId,
 * `closure` id = threadId.
 */
import type { FeatureCtx, Registry } from "../../engine/extensions";
import { lastShippedWeek, wantsClosureNote } from "./build";
import { KIND } from "../../storage/port";
import { closureNoteSchema, type ClosureNote } from "../../types";
import { createClosureDraftsPrompt, threadForDraft, type ClosureDraft } from "./drafts";
import { buildAll, readDerived, rebuildAndStore } from "./service";

/** Saves the week's closure drafts as `source: "agent"` records. A note the user wrote or edited is never overwritten. */
export async function saveClosureDrafts(week: { week: string; ext: Record<string, unknown>; shipped: ReadonlyArray<{ text: string; evidenceIds: string[] }> }, ctx: FeatureCtx): Promise<number> {
  const drafts = Array.isArray(week.ext.closures) ? (week.ext.closures as ClosureDraft[]) : [];
  if (drafts.length === 0) return 0;
  const { threads, closures, aliasToId } = await buildAll(ctx);
  let saved = 0;
  for (const d of drafts) {
    const thread = threadForDraft(d, week, threads);
    if (thread === undefined || thread.hidden || thread.status === "dropped") continue;
    if (closures.some((c) => (aliasToId.get(c.threadId) ?? c.threadId) === thread.id && c.source !== "agent")) continue;
    const note: ClosureNote = {
      threadId: thread.id, outcome: d.outcome, expectation: d.expectation, result: d.result, learnings: d.learnings,
      ...(d.impact === undefined ? {} : { impact: d.impact }), source: "agent", at: ctx.now().toISOString(),
    };
    if (!closureNoteSchema.safeParse(note).success) continue;
    await ctx.store.set(KIND.closure, thread.id, note);
    saved++;
  }
  return saved;
}

export function register(reg: Registry): void {
  reg.prompts.push(createClosureDraftsPrompt());
  reg.weekHooks.push({
    id: "threads",
    async afterWeekSaved(week, ctx) {
      await saveClosureDrafts(week, ctx);
      await rebuildAndStore(ctx);
    },
  });
  reg.grid.push({
    id: "threads",
    async contribute(grid, ctx) {
      const derived = await readDerived(ctx);
      if (derived === null) return;
      const visible = derived.threads.filter((t) => !t.hidden);
      for (const gw of grid.weeks) {
        gw.markers.shipped = visible.filter((t) => t.weeks.some((e) => e.week === gw.week && e.state === "shipped")).length;
        gw.markers.needClosure = visible.filter((t) => lastShippedWeek(t) === gw.week && wantsClosureNote(t, derived.todayWeek)).length;
      }
    },
  });
}
