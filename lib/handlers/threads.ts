/** handlers/threads.ts — threads.list / threads.edit / closure.set. */
import { previousWeeks } from "../engine/dates";
import { needClosureIds } from "../features/threads/build";
import { buildAll, rebuildAndStore } from "../features/threads/service";
import { KIND } from "../storage/port";
import { threadEditSchema, type ThreadEdit } from "../types";
import type { HandlersFn } from "./types";

type Methods = "threads.list" | "threads.edit" | "closure.set";

export const handlers: HandlersFn<Methods> = (ctx, _service, _env) => ({
  "threads.list": async ({ weeks }) => {
    const { threads, closures, aliasToId, todayWeek } = await buildAll(ctx);
    const start = previousWeeks(todayWeek, weeks - 1)[0] ?? todayWeek;
    const inWindow = threads.filter((t) => t.lastWeek >= start);
    const ids = new Set(inWindow.map((t) => t.id));
    // Closures are reported under the thread's current id, even after a merge changed it.
    const closuresOut = closures.map((c) => ({ ...c, threadId: aliasToId.get(c.threadId) ?? c.threadId })).filter((c) => ids.has(c.threadId));
    return { threads: inWindow, closures: closuresOut, needClosure: needClosureIds(inWindow, todayWeek) };
  },

  "threads.edit": async (input) => {
    const { aliasToId } = await buildAll(ctx);
    const id = aliasToId.get(input.threadId);
    if (id === undefined) throw new Error(`Unknown thread: ${input.threadId}`);
    if (input.drop !== null && input.drop.reason.trim() === "") throw new Error("A reason is required to drop a thread.");
    let mergeInto = input.mergeInto;
    if (mergeInto !== null && mergeInto !== "") {
      const target = aliasToId.get(mergeInto);
      if (target === undefined) throw new Error(`Unknown thread to merge into: ${mergeInto}`);
      if (target === id) throw new Error("A thread cannot be merged into itself.");
      mergeInto = target;
    }
    // Null means "leave as it is": fold into the stored edit. An empty title or mergeInto clears that edit.
    const prev = await ctx.store.get(KIND.threadEdit, id, threadEditSchema);
    const next: ThreadEdit = {
      threadId: id,
      title: input.title ?? prev?.title ?? null,
      mergeInto: mergeInto ?? prev?.mergeInto ?? null,
      hidden: input.hidden ?? prev?.hidden ?? null,
      extraKeys: [...new Set([...(prev?.extraKeys ?? []), ...input.extraKeys.map((k) => k.trim()).filter((k) => k !== "")])],
      drop: input.drop !== null ? { reason: input.drop.reason.trim() } : (prev?.drop ?? null),
    };
    await ctx.store.set(KIND.threadEdit, id, next);
    await rebuildAndStore(ctx);
    return { ok: true as const };
  },

  "closure.set": async (input) => {
    const { aliasToId } = await buildAll(ctx);
    const id = aliasToId.get(input.threadId);
    if (id === undefined) throw new Error(`Unknown thread: ${input.threadId}`);
    const impact = input.impact?.trim();
    await ctx.store.set(KIND.closure, id, {
      threadId: id,
      outcome: input.outcome,
      expectation: input.expectation.trim(),
      result: input.result.trim(),
      learnings: input.learnings.trim(),
      ...(impact ? { impact } : {}),
      source: "user" as const,
      at: ctx.now().toISOString(),
    });
    await rebuildAndStore(ctx);
    return { ok: true as const };
  },
});

