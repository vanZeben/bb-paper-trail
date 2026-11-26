/** handlers/ghost.ts — ghost.list, ghost.claim, ghost.dismiss, addenda.set. Logic in lib/features/ghost. */
import { claimGhost, dismissGhost, listGhosts, setNotes } from "../features/ghost/service";
import type { HandlersFn } from "./types";

type Methods = "ghost.list" | "ghost.claim" | "ghost.dismiss" | "addenda.set";

export const handlers: HandlersFn<Methods> = (ctx, _service, _env) => ({
  "ghost.list": async ({ weeks }) => ({ clusters: await listGhosts(ctx, weeks) }),
  "ghost.claim": async (input) => {
    await claimGhost(ctx, input);
    return { ok: true as const };
  },
  "ghost.dismiss": async ({ id }) => {
    await dismissGhost(ctx, id);
    return { ok: true as const };
  },
  "addenda.set": async ({ week, myNotes }) => {
    await setNotes(ctx, week, myNotes);
    return { ok: true as const };
  },
});
