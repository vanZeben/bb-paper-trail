import type { Registry } from "../../engine/extensions";
import { rebuildGhosts } from "./service";

/** Invisible-work radar: rebuild the clusters after every week save. */
export function register(reg: Registry): void {
  reg.weekHooks.push({
    id: "ghost",
    async afterWeekSaved(week, ctx) {
      await rebuildGhosts(ctx, week.week);
      ctx.publish();
    },
  });
}
