/** service.ts — store-backed setup: profile, the synthesis run (which applies automatically) and apply. */
import { z } from "zod";
import { localToday } from "../../engine/dates";
import type { FeatureCtx } from "../../engine/extensions";
import type { RunInput } from "../../engine/service";
import { ONBOARDING_META } from "../../handlers/core";
import { areaKeys, resolveArea } from "../../framework/rubric";
import { validateFramework, validateTargets } from "../../framework/service";
import { KIND } from "../../storage/port";
import {
  allocationTargetsSchema, goalsSchema, guardrailRuleSchema, profileSchema, roleFrameworkSchema, setupStateSchema,
  type GuardrailRule, type Goal, type Goals, type Inferred, type Profile, type RoleFramework, type SetupProposal, type SetupState,
} from "../../types";
import { planWeekNow } from "../plan";
import { reevaluateRecent, RULES_EDITED_META, validateRules } from "../guardrails/service";
import { synthesisJob } from "./synthesize";

const MIN = 60_000;
export const STATE_ID = "state";
export const MAX_GOALS_STORED = 8;

export interface SetupDeps {
  ctx: FeatureCtx;
  /** Queues the 4-week backfill. */
  run(input: RunInput): Promise<void>;
  /** Turns the scheduled capture on; absent when the host cannot write settings. */
  enableSchedule?: (() => Promise<void>) | undefined;
}

export const readProfile = (ctx: FeatureCtx) => ctx.store.get(KIND.profile, "active", profileSchema);
export const readState = (ctx: FeatureCtx) => ctx.store.get(KIND.setup, STATE_ID, setupStateSchema);
export const readGoals = async (ctx: FeatureCtx): Promise<Goals> => (await ctx.store.get(KIND.goals, "active", goalsSchema)) ?? { version: 1, goals: [], tasksRefreshedAt: null };

const writeState = async (ctx: FeatureCtx, state: Omit<SetupState, "at">) => {
  await ctx.store.set(KIND.setup, STATE_ID, { ...state, at: ctx.now().toISOString() });
  ctx.publish();
};

type Fact = "level" | "scope" | "managerName" | "reviewCadence";
type Owned = NonNullable<Inferred["userEdited"]>[number];
const FACTS: readonly Fact[] = ["level", "scope", "managerName", "reviewCadence"];
const FACT_LABEL: Record<Fact, string> = { level: "level", scope: "scope", managerName: "manager", reviewCadence: "review cadence" };
const factText = (v: string | null | undefined): string => (v ?? "").trim();

/** Setups in progress, per store. Taken synchronously, before any await, so two quick calls cannot both start a run. */
const inFlight = new WeakSet<object>();

/**
 * Stores identity and role card (and any edited inferred facts); keeps the framework's subject and manager in step.
 * A fact whose value differs from the stored one is marked `userEdited` (a later setup keeps it). The server owns
 * `setupAt` and the markers: a client cannot move or clear them.
 */
export async function saveProfile(ctx: FeatureCtx, input: Profile): Promise<void> {
  const parsed = profileSchema.parse(input);
  const card = parsed.roleCard;
  if (card !== null && card.kind === "url" && !/^https?:\/\/\S+$/.test(card.value.trim())) throw new Error("The role card link is not an http(s) URL.");
  if (card !== null && card.value.trim() === "") throw new Error("The role card is empty.");
  const stored = await readProfile(ctx);
  const owned = new Set<Owned>(stored?.inferred.userEdited ?? []);
  const basis = { ...parsed.inferred.basis };
  if (stored !== null) {
    for (const f of FACTS) {
      if (factText(parsed.inferred[f]) === factText(stored.inferred[f])) continue;
      owned.add(f);
      delete basis[f];
    }
  }
  const profile = profileSchema.parse({ ...parsed, setupAt: stored?.setupAt ?? null, inferred: { ...parsed.inferred, basis, userEdited: [...owned] } });
  await ctx.store.set(KIND.profile, "active", profile);
  const fw = await ctx.store.get(KIND.framework, "active", roleFrameworkSchema);
  if (fw !== null) {
    const name = profile.identity.name.slice(0, 60);
    if (fw.subject.name !== name || fw.managerName !== profile.inferred.managerName) {
      await ctx.store.set(KIND.framework, "active", { ...fw, subject: { ...fw.subject, name }, managerName: profile.inferred.managerName });
    }
  }
  ctx.publish();
}

const rulesSchema = z.array(guardrailRuleSchema);
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const frameworkShape = (f: RoleFramework) => ({ areas: f.areas.map((a) => [a.key, a.label, a.description, a.kind]), rubric: f.rubric });

/** `raw` re-keyed onto the framework's current keys (renames followed); null when any key has no home there. */
function rekey(framework: RoleFramework, raw: Readonly<Record<string, number>>): { out: Record<string, number>; dropped: boolean } {
  const out: Record<string, number> = {};
  let dropped = false;
  for (const [k, v] of Object.entries(raw)) {
    const to = resolveArea(framework, k);
    if (to === null) dropped = true;
    else out[to] = Math.round(((out[to] ?? 0) + v) * 10) / 10;
  }
  return { out, dropped };
}
const sumOf = (t: Readonly<Record<string, number>>): number => Object.values(t).reduce((a, b) => a + b, 0);

/** A split over exactly `keys` summing to 100: the wanted shares rescaled, or an even split when there is nothing to scale. */
function fitTargets(keys: readonly string[], wanted: Readonly<Record<string, number>>): Record<string, number> {
  const picked: Record<string, number> = {};
  for (const k of keys) picked[k] = wanted[k] ?? 0;
  const total = sumOf(picked);
  if (Math.abs(total - 100) <= 1) return picked;
  const out: Record<string, number> = {};
  if (total <= 0) for (const k of keys) out[k] = Math.floor((100 / keys.length) * 10) / 10;
  else for (const k of keys) out[k] = Math.round((picked[k]! * 100 * 10) / total) / 10;
  const biggest = [...keys].sort((a, b) => out[b]! - out[a]!)[0]!;
  out[biggest] = Math.round((out[biggest]! + 100 - sumOf(out)) * 10) / 10;
  return out;
}

/** Agent rules re-pointed at the framework's current keys; a rule naming an area that no longer exists is dropped. */
function fitRules(framework: RoleFramework, rules: readonly GuardrailRule[]): GuardrailRule[] {
  const out: GuardrailRule[] = [];
  for (const rule of rules) {
    const r = rule.rule;
    if ("areas" in r) {
      const areas = r.areas.map((a) => resolveArea(framework, a));
      if (areas.every((a): a is string => a !== null)) out.push({ ...rule, rule: { ...r, areas } });
    } else if ("area" in r && r.area !== null) {
      const area = resolveArea(framework, r.area);
      if (area !== null) out.push({ ...rule, rule: { ...r, area } });
    } else out.push(rule);
  }
  return out;
}

export interface ApplyResult {
  /** A plain-words note for the user, or null. */
  note: string | null;
  /** Labels of the parts where the user's own edits were kept although the new proposal differs ("work split", "guardrails", …). */
  kept: string[];
}

/**
 * Writes framework, targets, rules, goals and profile facts; completes onboarding, enables the schedule and queues a backfill.
 * Anything the user has edited since the last setup is kept, and only agent-set values are replaced: the framework
 * (`updatedAt` after `profile.setupAt`), the targets (same), the rules (the `rules-edited-at` meta), facts the user changed
 * (`inferred.userEdited`) and goals with source "user". Parts kept once stay marked in `inferred.userEdited`.
 */
export async function applySetup(deps: SetupDeps, proposal: SetupProposal): Promise<ApplyResult> {
  const { ctx } = deps;
  const now = ctx.now();
  const stamp = now.toISOString();
  const profile = await readProfile(ctx);
  const setupAt = profile?.setupAt ?? null;
  const marked = new Set<Owned>(profile?.inferred.userEdited ?? []);
  const after = (iso: string | null | undefined): boolean => setupAt !== null && iso != null && Date.parse(iso) > Date.parse(setupAt);
  const kept: string[] = [];
  const notes: string[] = [];
  const owned = new Set<Owned>();

  // facts
  const inferred: Inferred = { ...proposal.inferred, basis: { ...proposal.inferred.basis } };
  if (profile !== null) {
    for (const f of FACTS) {
      if (!marked.has(f)) continue;
      owned.add(f);
      if (factText(profile.inferred[f]) !== factText(proposal.inferred[f])) kept.push(FACT_LABEL[f]);
      inferred[f] = profile.inferred[f];
      const own = profile.inferred.basis[f];
      if (own === undefined) delete inferred.basis[f];
      else inferred.basis[f] = own;
    }
  }

  // framework
  const stored = await ctx.store.get(KIND.framework, "active", roleFrameworkSchema);
  let framework: RoleFramework;
  if (stored !== null && (marked.has("framework") || after(stored.updatedAt))) {
    owned.add("framework");
    if (!sameJson(frameworkShape(stored), frameworkShape(proposal.framework))) kept.push("areas");
    framework = { ...stored, subject: { ...stored.subject, name: profile?.identity.name.slice(0, 60) || stored.subject.name }, managerName: inferred.managerName };
  } else {
    framework = { ...validateFramework(proposal.framework, await ctx.framework(), now), managerName: inferred.managerName };
  }
  const keys = areaKeys(framework);

  // targets
  const oldTargets = await ctx.store.get(KIND.targets, "active", allocationTargetsSchema);
  const wanted = fitTargets(keys, rekey(framework, proposal.targets).out);
  let split = wanted;
  let keepSplit = false;
  if (oldTargets !== null && (marked.has("targets") || after(oldTargets.updatedAt))) {
    const mine = rekey(framework, oldTargets.targets);
    if (!mine.dropped && Math.abs(sumOf(mine.out) - 100) <= 1) {
      keepSplit = true;
      split = mine.out;
      owned.add("targets");
      if (keys.some((k) => Math.abs((mine.out[k] ?? 0) - (wanted[k] ?? 0)) > 0.05)) kept.push("work split");
    } else notes.push("Your own work split named areas that are no longer in the framework, so the agent's split was used.");
  }
  const targets = validateTargets(
    { version: 1, frameworkId: framework.id, targets: split, windowWeeks: oldTargets?.windowWeeks ?? 4, thresholds: oldTargets?.thresholds ?? { watch: 10, off: 20 }, updatedAt: stamp },
    framework,
    now,
  );

  // guardrails
  const oldRules = await ctx.store.get(KIND.rules, "active", rulesSchema);
  let rules: GuardrailRule[];
  if (oldRules !== null && (marked.has("guardrails") || after(await ctx.store.getMeta(RULES_EDITED_META)))) {
    owned.add("guardrails");
    rules = oldRules;
    if (!sameJson(oldRules, proposal.guardrails)) kept.push("guardrails");
  } else rules = fitRules(framework, proposal.guardrails);
  validateRules(rules);

  // goals: the user's own first, the agent's fill what is left
  const home = (a: string | null): string | null => (a === null ? null : resolveArea(framework, a));
  const mine = (await readGoals(ctx)).goals.filter((g) => g.source === "user").map((g) => ({ ...g, area: home(g.area) }));
  const made: Goal[] = proposal.goals.map((g, i) => ({ id: `goal-${now.getTime().toString(36)}-${i + 1}`, text: g.text, area: home(g.area), source: "setup", basis: g.basis, createdAt: stamp, tasks: [], droppedRefs: [] }));
  const room = Math.max(0, MAX_GOALS_STORED - mine.length);
  if (mine.length > 0 && made.length > room) kept.push("goals");

  await ctx.store.set(KIND.framework, "active", framework);
  await ctx.store.set(KIND.targets, "active", keepSplit && oldTargets !== null ? { ...targets, updatedAt: oldTargets.updatedAt } : targets);
  await ctx.store.set(KIND.rules, "active", rules);
  await ctx.store.set(KIND.goals, "active", { version: 1, goals: [...mine, ...made.slice(0, room)], tasksRefreshedAt: (await readGoals(ctx)).tasksRefreshedAt });
  if (profile !== null) await ctx.store.set(KIND.profile, "active", { ...profile, inferred: { ...inferred, userEdited: [...owned] }, setupAt: stamp });

  await ctx.store.setMeta(ONBOARDING_META, JSON.stringify({ completed: true, at: stamp }));
  await reevaluateRecent(ctx).catch((cause: unknown) => ctx.log.warn(`setup: guardrail re-evaluation failed: ${cause instanceof Error ? cause.message : String(cause)}`));
  ctx.publish();

  if (!ctx.settings().enabled) {
    if (deps.enableSchedule) await deps.enableSchedule().catch((cause: unknown) => notes.push(`Could not turn the schedule on: ${cause instanceof Error ? cause.message : String(cause)}`));
    else notes.push("Scheduled capture is off; turn it on in bb's settings for this plugin.");
  }
  await deps.run({ kind: "backfill", weeks: 4, force: false }).catch((cause: unknown) => notes.push(`The 4-week backfill could not start: ${cause instanceof Error ? cause.message : String(cause)}`));
  void planWeekNow(ctx, undefined, "setup");
  return { note: notes.length > 0 ? notes.join(" ") : null, kept: [...new Set(kept)] };
}

/** Starts "figure it out" and returns at once; on success the proposal is applied without a review step. A second call while one runs is refused. */
export async function startSynthesis(deps: SetupDeps): Promise<void> {
  const { ctx } = deps;
  if (inFlight.has(ctx.store)) throw new Error("Setup is already running.");
  inFlight.add(ctx.store);
  let started = false;
  try {
    const s = ctx.settings();
    const profile = await readProfile(ctx);
    if (profile === null || profile.identity.name.trim() === "") throw new Error("Add your name first.");
    const timeoutMs = s.judgeTimeoutMinutes * MIN;
    const current = await readState(ctx);
    if (current?.status === "running" && ctx.now().getTime() - Date.parse(current.at) < timeoutMs + MIN) throw new Error("Setup is already running.");
    const previous = current?.proposal ?? null;
    const previousKept = current?.kept ?? [];
    await writeState(ctx, { status: "running", proposal: previous, error: null, kept: previousKept });
    const today = localToday(ctx.now(), s.timeZone);
    const existing = await ctx.store.get(KIND.framework, "active", roleFrameworkSchema);
    started = true;
    void (async () => ctx.runner.runJob(synthesisJob(profile, { timeZone: s.timeZone, today, now: ctx.now, existing }), { model: s.judgeModel || undefined, timeoutMs, retryOnWorkerError: false }))()
      .then(async (proposal) => {
        const { note, kept } = await applySetup(deps, proposal);
        await writeState(ctx, { status: "applied", proposal, error: note, kept });
      })
      .catch((cause: unknown) => writeState(ctx, { status: "failed", proposal: previous, error: cause instanceof Error ? cause.message : String(cause), kept: previousKept }))
      .catch((cause: unknown) => ctx.log.warn(`setup: could not store the result: ${cause instanceof Error ? cause.message : String(cause)}`))
      .finally(() => inFlight.delete(ctx.store));
  } finally {
    if (!started) inFlight.delete(ctx.store);
  }
}

/**
 * Re-applies the stored proposal (used by setup.apply). It goes through the same merge as a fresh run, so a proposal that
 * is older than the user's latest edit cannot overwrite that edit.
 */
export async function reapply(deps: SetupDeps): Promise<void> {
  if (inFlight.has(deps.ctx.store)) throw new Error("Setup is already running.");
  inFlight.add(deps.ctx.store);
  try {
    const state = await readState(deps.ctx);
    if (state?.proposal == null) throw new Error("There is no setup to apply yet. Run \"Figure it out\" first.");
    const { note, kept } = await applySetup(deps, state.proposal);
    await writeState(deps.ctx, { status: "applied", proposal: state.proposal, error: note, kept });
  } finally {
    inFlight.delete(deps.ctx.store);
  }
}
