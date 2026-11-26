/** handlers/guardrails.ts — rules (defaults on first read), results and acknowledgement. */
import { isoWeekOf, localToday, previousWeeks } from "../engine/dates";
import { SEVERITY_RANK } from "../features/guardrails/lifecycle";
import { acknowledgeResult, loadResults, loadRules, reevaluateRecent, RULES_EDITED_META, RULES_ID, validateRules } from "../features/guardrails/service";
import { KIND } from "../storage/port";
import type { HandlersFn } from "./types";

type Methods = "guardrails.rules.get" | "guardrails.rules.set" | "guardrails.results" | "guardrails.ack";

export const handlers: HandlersFn<Methods> = (ctx) => ({
  "guardrails.rules.get": async () => ({ rules: await loadRules(ctx) }),
  "guardrails.rules.set": async ({ rules }) => {
    validateRules(rules);
    await ctx.store.set(KIND.rules, RULES_ID, rules);
    await ctx.store.setMeta(RULES_EDITED_META, ctx.now().toISOString());
    await reevaluateRecent(ctx);
    ctx.publish();
    return { rules };
  },
  "guardrails.results": async ({ weeks, state }) => {
    const current = isoWeekOf(localToday(ctx.now(), ctx.settings().timeZone));
    const oldest = previousWeeks(current, weeks - 1)[0] ?? current;
    const results = (await loadResults(ctx.store))
      .filter((r) => r.week >= oldest && (state === undefined || r.state === state))
      .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || (a.week < b.week ? 1 : -1));
    return { results };
  },
  "guardrails.ack": async ({ id, note }) => {
    await acknowledgeResult(ctx, id, note);
    return { ok: true as const };
  },
});
