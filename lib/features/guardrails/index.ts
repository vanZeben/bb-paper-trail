import type { Registry } from "../../engine/extensions";
import type { GridV2 } from "../../types";
import { SEVERITY_RANK } from "./lifecycle";
import { evaluateWeek, loadResults } from "./service";

/**
 * Guardrails feature: a week hook evaluates the rules and writes `violation` records (`${ruleId}:${week}`); a grid
 * contributor sets `markers.guardrail` (worst open severity) and `guardrailCount` per week.
 */
export function register(reg: Registry): void {
  reg.weekHooks.push({
    id: "guardrails",
    async afterWeekSaved(week, ctx) {
      await evaluateWeek(ctx, week.week);
    },
  });
  reg.grid.push({
    id: "guardrails",
    async contribute(grid: GridV2, ctx) {
      const open = (await loadResults(ctx.store)).filter((r) => r.state === "open");
      for (const w of grid.weeks) {
        const here = open.filter((r) => r.week === w.week);
        if (here.length === 0) continue;
        w.markers.guardrailCount = here.length;
        w.markers.guardrail = here.reduce((worst, r) => (SEVERITY_RANK[r.severity] > SEVERITY_RANK[worst] ? r.severity : worst), here[0]!.severity);
      }
    },
  });
}
