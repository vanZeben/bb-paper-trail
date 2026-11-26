/**
 * service.ts — the weekly work log: capture orchestration, day rating, the Friday judgment, record + index writes,
 * the scheduling tick and backfill. Every model-backed job goes through `runner.runJob`, i.e. the WorkerPort that
 * runs hidden threads. Feature modules plug in through the Registry (prompt extensions, day/week hooks, grid
 * contributors); the service never imports them.
 */
import { OFF, type DateRange } from "../capture/common";
import { createConfluenceAgentActivity } from "../capture/confluence";
import { worklogContextJob, type ContextCapture } from "../capture/context";
import { githubMcpJob, worklogGithubJob } from "../capture/github";
import { createJiraAgentActivity } from "../capture/jira";
import { meetingsJob, type NoteSource } from "../capture/meetings";
import { worklogSlackJob } from "../capture/slack";
import type { Settings } from "../settings";
import { splitList } from "../settings";
import { KIND, type Store } from "../storage/port";
import {
  MAX_BACKFILL_WEEKS,
  SOURCE_IDS,
  clip,
  profileSchema,
  workDaySchema,
  workWeekSchema,
  worklogIndexSchema,
  weekAddendaSchema,
  type ConnectorCheck,
  type DayRating,
  type GridV2,
  type RoleFramework,
  type SourceId,
  type SourcePart,
  type WorkDay,
  type WorkMeeting,
  type WorkWeek,
  type WorklogIndex,
  type WorklogStatus,
} from "../types";
import { addDays, isoWeekOf, isWeekday, localToday, previousWeeks, weekDates } from "./dates";
import { coverageLine, mergeDay, weekCoverage, withAllSources, worstStatus } from "./evidence";
import {
  dayPromptExtras,
  runDayHooks,
  runGridContributors,
  runTickHooks,
  runWeekHooks,
  validateWeekExtras,
  weekPromptExtras,
  type FeatureCtx,
  type PromptCtx,
  type Registry,
} from "./extensions";
import { buildGrid } from "./grid";
import { weekMarkdown } from "./markdown";
import { matchNotes, weekMeetingStats } from "./meetings";
import { createSerialQueue } from "./queue";
import { dayRatingJob, weekJudgeJob } from "./rating";
import type { Log, Runner } from "./runner";
import { dueRefreshSlot } from "./schedule";
import { localParts } from "./time";

export const WORKLOG_DAILY_SLOT_KEY = "worklog_daily_last_slot";
export const WORKLOG_WEEKLY_SLOT_KEY = "worklog_weekly_last_slot";
export const catchupKey = (week: string) => `worklog-catchup:${week}`;
const MAX_CATCHUP_ATTEMPTS = 2;
const DEFAULT_WEEK_END_TIME = "18:00"; // Friday, local: the weekly report is final from here on
export const WORKLOG_MAX_LATE_MS = 6 * 60 * 60 * 1000;
export const INDEX_ID = "main";
const INDEX_KEEP_WEEKS = 60;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface WorklogServiceDeps {
  store: Store;
  runner: Runner;
  registry: Registry;
  /** Same object the feature hooks get (store/settings/framework/runner/log/publish/now). */
  ctx: FeatureCtx;
  settings: () => Settings;
  /** Active framework (default when none stored). */
  framework: () => Promise<RoleFramework>;
  /** Latest connector check, or null if never run. Sources it marks available:false are `off` (no job runs). */
  connectors: () => Promise<ConnectorCheck | null>;
  /** True once onboarding completed; the scheduled tick does nothing before that. */
  onboarded: () => Promise<boolean>;
  notify: () => void; // realtime publish
  now?: () => Date;
  log?: Log;
}

export type RunInput =
  | { kind: "day"; date: string }
  | { kind: "week"; week: string; recapture?: boolean }
  | { kind: "backfill"; weeks?: number; force?: boolean }
  | { kind: "fill_gaps"; weeks: number };

export interface WorklogService {
  grid(weeks?: number): Promise<GridV2>;
  day(date: string): Promise<WorkDay | null>;
  week(week: string): Promise<WorkWeek | null>;
  weekFinal(week: string): Promise<boolean>;
  weekMarkdown(week: string): Promise<{ markdown: string; filename: string }>;
  index(): Promise<WorklogIndex>;
  /** Validates and enqueues; returns at once (throws a plain Error for invalid input). */
  run(input: RunInput): Promise<void>;
  /** Same work, awaited (used by the CLI "waits" commands). */
  runDayNow(date: string): Promise<WorkDay>;
  runWeekNow(week: string, recapture?: boolean): Promise<WorkWeek>;
  status(): WorklogStatus;
  scheduledTick(): Promise<void>;
  /** Rebuild the index from all stored day/week records (after import). */
  rebuildIndex(): Promise<void>;
  /** For the migration agent: save already-built records and update the index (no hooks). */
  importDay(day: WorkDay): Promise<void>;
  importWeek(week: WorkWeek): Promise<void>;
  /** Run every WeekHook over stored weeks (after import), oldest first. */
  replayWeekHooks(weeks?: string[]): Promise<number>;
}

interface WeekRunOptions {
  recapture: boolean;
  recaptureToday: boolean;
}

/** Which sources are on for one capture, resolved once from the settings and the latest connector check. */
interface SourceState {
  enabled: ReadonlySet<SourceId>;
  /** Why a disabled source is off (shown in its coverage note). */
  offNote: (source: SourceId) => string;
  githubMode: "gh" | "mcp";
  noteSources: NoteSource[];
}

const emptyIndex = (): WorklogIndex => ({ version: 2, days: {}, weeks: {} });
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const MIN = 60_000;

/** "0 18 * * 5" -> "18:00"; anything that is not a plain minute + hour falls back to 18:00. */
export function weekEndTime(weeklyCron: string): string {
  const f = weeklyCron.trim().split(/\s+/);
  if (f.length !== 5 || !/^\d{1,2}$/.test(f[0]!) || !/^\d{1,2}$/.test(f[1]!)) return DEFAULT_WEEK_END_TIME;
  const [m, h] = [Number(f[0]), Number(f[1])];
  if (m > 59 || h > 23) return DEFAULT_WEEK_END_TIME;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function createWorklogService(deps: WorklogServiceDeps): WorklogService {
  const { store, runner, registry, ctx, settings } = deps;
  const now = deps.now ?? (() => new Date());
  const log: Log | undefined = deps.log ?? ctx.log;
  const queue = createSerialQueue(deps.notify, now);
  const warn = (prefix: string, cause: unknown) => log?.warn(`worklog ${prefix}: ${message(cause)}`);
  const tz = () => settings().timeZone;
  const today = () => localToday(now(), tz());

  // ─── storage ───────────────────────────────────────────────────────────────

  const readIndex = async (): Promise<WorklogIndex> => (await store.get(KIND.index, INDEX_ID, worklogIndexSchema)) ?? emptyIndex();
  // Records stored before a source existed lack its coverage key; fill it so every reader sees all sources.
  const getDay = async (date: string): Promise<WorkDay | null> => {
    const day = await store.get(KIND.day, date, workDaySchema);
    return day === null ? null : { ...day, coverage: withAllSources(day.coverage) };
  };
  const getWeek = async (week: string): Promise<WorkWeek | null> => {
    const record = await store.get(KIND.week, week, workWeekSchema);
    return record === null ? null : { ...record, coverage: withAllSources(record.coverage) };
  };

  function prune(index: WorklogIndex): void {
    const oldestWeek = previousWeeks(isoWeekOf(today()), INDEX_KEEP_WEEKS)[0]!;
    const oldestDate = weekDates(oldestWeek)[0]!;
    for (const date of Object.keys(index.days)) if (date < oldestDate) delete index.days[date];
    for (const week of Object.keys(index.weeks)) if (week < oldestWeek) delete index.weeks[week];
  }

  // The index is a read-modify-write of one record. Every writer (run tasks, the import's saves, rebuildIndex) goes
  // through this lock, so two concurrent updates can never overwrite each other.
  let indexLock: Promise<unknown> = Promise.resolve();
  function withIndexLock<T>(task: () => Promise<T>): Promise<T> {
    const run = indexLock.then(task, task);
    indexLock = run.catch(() => undefined);
    return run;
  }

  function writeIndex(change: (index: WorklogIndex) => void): Promise<void> {
    return withIndexLock(async () => {
      const index = await readIndex();
      change(index);
      prune(index);
      await store.set(KIND.index, INDEX_ID, index);
    });
  }

  const indexDay = (day: WorkDay): WorklogIndex["days"][string] => {
    const coverage = withAllSources(day.coverage);
    const evidenceBySource: Record<string, number> = {};
    for (const e of day.evidence) evidenceBySource[e.source] = (evidenceBySource[e.source] ?? 0) + 1;
    return {
      rating: day.rating?.rating ?? null,
      provisional: day.rating?.provisional ?? false,
      reason: day.rating?.reason ?? null,
      meetingMinutes: day.meetingMinutes,
      evidenceCount: day.evidence.length,
      worstCoverage: worstStatus(coverage),
      areas: day.rating?.areas ?? [],
      evidenceBySource,
      coverage: Object.fromEntries(Object.entries(coverage).map(([source, c]) => [source, c.status])),
    };
  };

  async function saveDay(day: WorkDay): Promise<void> {
    await store.set(KIND.day, day.date, day);
    await writeIndex((index) => {
      index.days[day.date] = indexDay(day);
    });
  }

  async function saveWeek(record: WorkWeek): Promise<void> {
    await store.set(KIND.week, record.week, record);
    await writeIndex((index) => {
      index.weeks[record.week] = { rating: record.rating, final: record.final, generatedAt: record.generatedAt };
    });
  }

  // ─── sources ───────────────────────────────────────────────────────────────

  async function sourceState(): Promise<SourceState> {
    const s = settings();
    const check = await deps.connectors();
    const enabled = new Set<SourceId>(s.enabledSources.filter((id) => check?.sources[id]?.available !== false));
    return {
      enabled,
      offNote: (source) => (!s.enabledSources.includes(source) ? "turned off in settings" : (check?.sources[source]?.note ?? "not connected")),
      githubMode: check?.sources.github?.mode === "mcp" ? "mcp" : "gh",
      noteSources: (["granola", "fellow"] as const).filter((id) => enabled.has(id)),
    };
  }

  // ─── validation ────────────────────────────────────────────────────────────

  async function validateDay(date: string): Promise<void> {
    if (!DATE_RE.test(date)) throw new Error(`Invalid date: ${date}`);
    if (date > today()) throw new Error(`${date} is in the future`);
    if (!isWeekday(date)) throw new Error(`${date} is a weekend`);
    const week = isoWeekOf(date);
    if ((await readIndex()).weeks[week]?.final === true) throw new Error(`Week ${week} is final; re-run the week instead`);
  }

  function validateWeek(week: string): void {
    const dates = weekDates(week); // throws on a bad week
    if (dates[0]! > today()) throw new Error(`Week ${week} has not started`);
  }

  // ─── capture ───────────────────────────────────────────────────────────────

  const captureModel = () => settings().captureModel || undefined;
  const judgeModel = () => settings().judgeModel || undefined;
  const jobOpts = () => ({ model: captureModel(), timeoutMs: settings().captureTimeoutMinutes * MIN, retryOnWorkerError: false });
  const failedPart = (cause: unknown): SourcePart => ({ coverage: { status: "failed", note: clip(message(cause), 200) }, entries: [] });
  const failedRange = (range: DateRange, cause: unknown): Record<string, SourcePart> => {
    const out: Record<string, SourcePart> = {};
    for (let d = range.from; d <= range.to; d = addDays(d, 1)) out[d] = failedPart(cause);
    return out;
  };
  const allSources = (): ReadonlySet<SourceId> => new Set(SOURCE_IDS);

  /** Who the user is, from the profile record. Passed to every capture job builder; nothing when there is no profile yet. */
  async function identityOption(): Promise<{ identity: { name: string; email: string | null; handles: Record<string, string> } } | Record<string, never>> {
    const profile = await store.get(KIND.profile, "active", profileSchema).catch(() => null);
    if (profile === null) return {};
    const { name, email, handles } = profile.identity;
    return { identity: { name, email, handles } };
  }

  /**
   * Capture sources for the given days. Never throws: a failing source becomes failed coverage with a note, and a
   * failed re-capture never replaces data a previous capture got. Sources that are off get `off` coverage and no job.
   */
  async function captureDays(wanted: ReadonlyMap<string, ReadonlySet<SourceId>>, state: SourceState, setStep: (step: string) => void): Promise<void> {
    const dates = [...wanted.keys()].sort();
    if (dates.length === 0) return;
    const s = settings();
    const timeZone = s.timeZone;
    const on = (source: SourceId) => state.enabled.has(source);
    // The date span of a source across the wanted days, or null when no wanted day needs it (or it is off).
    const range = (source: SourceId): DateRange | null => {
      if (!on(source)) return null;
      const list = dates.filter((d) => wanted.get(d)!.has(source));
      return list.length === 0 ? null : { from: list[0]!, to: list[list.length - 1]! };
    };
    const wants = (date: string, source: SourceId) => on(source) && wanted.get(date)!.has(source);
    const t = today();

    const github = range("github");
    const jiraRange = range("jira");
    const confluenceRange = range("confluence");
    const vaultRange = range("vault");
    const memoryRange = range("memory");
    const contextRange =
      vaultRange === null ? memoryRange : memoryRange === null ? vaultRange : { from: [vaultRange.from, memoryRange.from].sort()[0]!, to: [vaultRange.to, memoryRange.to].sort()[1]! };
    const timeoutMs = () => s.captureTimeoutMinutes * MIN;
    const who = await identityOption();
    const jira = createJiraAgentActivity(runner, captureModel, { timeZone, siteUrl: s.jiraSiteUrl || undefined, timeoutMs, ...who });
    const confluence = createConfluenceAgentActivity(runner, captureModel, { timeZone, timeoutMs, ...who });
    const none = () => Promise.resolve<Record<string, SourcePart>>({});

    setStep("capturing code, issues, docs, notes and memory");
    const [ghParts, jiraParts, confluenceParts, contextParts] = await Promise.all([
      github === null
        ? none()
        : runner
            .runJob(
              state.githubMode === "mcp"
                ? githubMcpJob(github, { timeZone, org: s.githubOrg, ...who })
                : worklogGithubJob(github, { org: s.githubOrg, includePending: github.to >= addDays(t, -1), timeZone, now: now(), ...who }),
              jobOpts(),
            )
            .catch((cause: unknown) => failedRange(github, cause)),
      jiraRange === null ? none() : jira.fetch(jiraRange).catch((cause: unknown) => failedRange(jiraRange, cause)),
      confluenceRange === null ? none() : confluence.fetch(confluenceRange).catch((cause: unknown) => failedRange(confluenceRange, cause)),
      contextRange === null
        ? Promise.resolve<ContextCapture>({ vault: {}, memory: {} })
        : runner
            .runJob(worklogContextJob(contextRange, { timeZone, skipFolders: splitList(s.notesSkipFolders), includeVault: on("vault"), includeMemory: on("memory"), ...who }), jobOpts())
            .catch((cause: unknown): ContextCapture => ({ vault: failedRange(contextRange, cause), memory: failedRange(contextRange, cause) })),
    ]);

    for (const [i, date] of dates.entries()) {
      setStep(`capturing ${date} (${i + 1}/${dates.length})`);
      const prev = await getDay(date);
      const parts: Partial<Record<SourceId, SourcePart>> = {};
      let meetings: Array<Omit<WorkMeeting, "id">> | null = null;
      const wantMeetings = wants(date, "calendar") || wants(date, "granola") || wants(date, "fellow");
      const wantSlack = wants(date, "slack");

      const [meetingsResult, slackResult] = await Promise.all([
        wantMeetings ? runner.runJob(meetingsJob(date, { timeZone, noteSources: state.noteSources, ...who }), jobOpts()).then((value) => ({ value }), (error: unknown) => ({ error })) : null,
        wantSlack ? runner.runJob(worklogSlackJob(date, { timeZone, watchedChannels: splitList(s.watchedChannels), ...who }), jobOpts()).then((value) => ({ value }), (error: unknown) => ({ error })) : null,
      ]);

      if (meetingsResult !== null) {
        if ("value" in meetingsResult) {
          const m = meetingsResult.value;
          parts.calendar = { coverage: m.calendar.coverage, entries: [] };
          parts.granola = { coverage: m.granola.coverage, entries: m.granola.entries };
          parts.fellow = { coverage: m.fellow.coverage, entries: m.fellow.entries };
          if (m.calendar.coverage.status !== "failed") {
            // A note source failed but the calendar worked: match against the previous notes so the noted / passive flags survive.
            const notes = [
              ...(m.granola.coverage.status === "failed"
                ? (prev?.meetings ?? []).filter((x) => x.noted).map((x) => ({ title: x.title, start: x.start as string | null, passive: x.passive === true }))
                : m.granola.notes),
            ];
            // Fellow notes also mark a meeting as noted (and passive or not) where the other source has none.
            notes.push(...m.fellow.notes.filter((f) => !notes.some((n) => n.title === f.title)));
            meetings = matchNotes(m.calendar.meetings as WorkMeeting[], notes);
          }
        } else {
          parts.calendar = failedPart(meetingsResult.error);
          parts.granola = failedPart(meetingsResult.error);
          parts.fellow = failedPart(meetingsResult.error);
        }
      }
      if (slackResult !== null) parts.slack = "value" in slackResult ? slackResult.value : failedPart(slackResult.error);
      if (wants(date, "github")) parts.github = ghParts[date] ?? failedPart("no code host data returned for this date");
      if (wants(date, "jira")) parts.jira = jiraParts[date] ?? failedPart("no issue tracker data returned for this date");
      if (wants(date, "confluence")) parts.confluence = confluenceParts[date] ?? failedPart("no wiki data returned for this date");
      if (wants(date, "vault")) parts.vault = contextParts.vault[date] ?? failedPart("no notes data returned for this date");
      if (wants(date, "memory")) parts.memory = contextParts.memory[date] ?? failedPart("no memory data returned for this date");

      // Sources that are off: `off` coverage, no entries, never a failure.
      for (const source of SOURCE_IDS) {
        if (on(source) || !(wanted.get(date)!.has(source) || parts[source] !== undefined)) continue;
        parts[source] = { coverage: OFF(state.offNote(source)), entries: [] };
        if (source === "calendar") meetings = [];
      }

      // A source that failed now keeps what an earlier capture got (the failure is only logged).
      for (const source of SOURCE_IDS) {
        const part = parts[source];
        const before = prev?.coverage[source]?.status;
        if (part?.coverage.status === "failed" && (before === "ok" || before === "partial")) {
          warn(`capture ${date}`, `${source} failed (${part.coverage.note}); kept the previous capture`);
          delete parts[source];
          if (source === "calendar") meetings = null;
        }
      }
      await saveDay(mergeDay(prev, date, parts, meetings, now(), timeZone));
      deps.notify();
    }
  }

  /** Sources a stored day still needs: the ones that failed, plus the enabled ones recorded as off; off ones are re-marked. */
  function missingSources(day: WorkDay, state: SourceState): Set<SourceId> {
    const out = new Set<SourceId>();
    for (const source of SOURCE_IDS) {
      const status = day.coverage[source]?.status;
      if (state.enabled.has(source) ? status === "failed" || status === "off" : status !== "off") out.add(source);
    }
    return out;
  }

  // ─── rating ────────────────────────────────────────────────────────────────

  /** Provisional rating of one captured day. Skipped without a model call when there is no evidence at all. */
  async function rateDay(day: WorkDay, state: SourceState): Promise<void> {
    const ratedAt = now().toISOString();
    let rating: DayRating;
    if (day.evidence.length === 0) {
      rating = { rating: "none", provisional: true, reason: `No evidence captured (${coverageLine(day.coverage)})`, summary: "", areas: [], evidenceIds: [], ratedAt, model: null };
    } else {
      const framework = await deps.framework();
      const s = settings();
      const extraRules = await dayPromptExtras(registry, { week: day.week, dates: [day.date], framework, settings: s, store, date: day.date });
      const judged = await runner.runJob(
        dayRatingJob({
          day,
          framework,
          workdayHours: s.workdayHours,
          timeZone: s.timeZone,
          extraRules,
          enabledNoteSources: state.noteSources,
          onUnknownIds: (ids) => warn(`rate ${day.date}`, `dropped unknown evidence ids: ${ids.join(", ")}`),
        }),
        jobOpts(),
      );
      rating = { ...judged, provisional: true, ratedAt, model: captureModel() ?? null };
    }
    const rated: WorkDay = { ...day, rating };
    await saveDay(rated);
    await runDayHooks(registry, rated, ctx);
  }

  async function runDayTask(date: string, setStep: (step: string) => void): Promise<void> {
    await validateDay(date);
    const state = await sourceState();
    await captureDays(new Map([[date, allSources()]]), state, setStep);
    const day = await getDay(date);
    if (day === null) throw new Error(`capture for ${date} produced no day`);
    setStep(`rating ${date}`);
    await rateDay(day, state);
    deps.notify();
  }

  async function runWeekTask(week: string, { recapture, recaptureToday }: WeekRunOptions, setStep: (step: string) => void): Promise<void> {
    const s = settings();
    const timeZone = s.timeZone;
    const all = weekDates(week);
    const at = now();
    const t = localToday(at, timeZone);
    const dates = all.filter((d) => d <= t);
    if (dates.length === 0) throw new Error(`Week ${week} has not started`);
    // Final only once the working week is over: after Friday, or on Friday from the weekly slot time.
    const final = all[4]! < t || (all[4]! === t && localParts(at, timeZone).time >= weekEndTime(s.weeklyCron));
    const state = await sourceState();

    // 1. Capture what is missing (all sources when recapturing, only the failed ones otherwise).
    const wanted = new Map<string, ReadonlySet<SourceId>>();
    for (const date of dates) {
      const existing = await getDay(date);
      if (recapture || existing === null || (recaptureToday && date === t)) wanted.set(date, allSources());
      else {
        const missing = missingSources(existing, state);
        if (missing.size > 0) wanted.set(date, missing);
      }
    }
    await captureDays(wanted, state, setStep);

    // 2. One judgment with the whole week in context.
    const days = (await Promise.all(dates.map(getDay))).filter((d): d is WorkDay => d !== null);
    const [framework, previous] = await Promise.all([deps.framework(), getWeek(previousWeeks(week, 1)[0]!)]);
    const promptCtx: PromptCtx = { week, dates: all, framework, settings: s, store };
    const extras = await weekPromptExtras(registry, promptCtx);
    setStep(`judging ${week}`);
    const job = weekJudgeJob({
      week,
      dates: all,
      days,
      framework,
      workdayHours: s.workdayHours,
      timeZone,
      extraRules: extras.rules,
      extraReplyExample: extras.replyExample,
      enabledNoteSources: state.noteSources,
      previous,
      onUnknownIds: (ids) => warn(`judge ${week}`, `dropped unknown evidence ids: ${ids.join(", ")}`),
    });
    // An extension that rejects the reply makes the runner retry once, like any malformed reply.
    const judgment = await runner.runJob(
      { ...job, validate: (data) => { const result = job.validate(data); validateWeekExtras(registry, result.raw, promptCtx); return result; } },
      { model: judgeModel(), timeoutMs: s.judgeTimeoutMinutes * MIN, retryOnWorkerError: false },
    );
    const ext = validateWeekExtras(registry, judgment.raw, promptCtx);

    // 3. Apply each judged day onto its stored day.
    const ratedAt = now().toISOString();
    const model = judgeModel() ?? null;
    const updated: WorkDay[] = [];
    for (const day of days) {
      const j = judgment.days.find((d) => d.date === day.date)!;
      const next: WorkDay = { ...day, rating: { rating: j.rating, provisional: !final, reason: j.reason, summary: j.summary, areas: j.areas, evidenceIds: j.evidenceIds, ratedAt, model } };
      await saveDay(next);
      updated.push(next);
    }

    // 4. The week record.
    const daysWorked = judgment.days.filter((d) => d.rating !== "none").length;
    const record: WorkWeek = {
      version: 2,
      week,
      from: all[0]!,
      to: all[4]!,
      generatedAt: ratedAt,
      model,
      final,
      rating: judgment.rating,
      ratingReason: judgment.ratingReason,
      threeLines: judgment.threeLines,
      days: judgment.days.map((d) => ({ date: d.date, rating: d.rating, reason: d.reason, summary: d.summary, evidenceIds: d.evidenceIds })),
      daysWorked,
      scorecard: judgment.scorecard,
      shipped: judgment.shipped,
      inProgress: judgment.inProgress,
      decisions: judgment.decisions,
      helping: judgment.helping,
      meetings: weekMeetingStats(updated, daysWorked, s.workdayHours),
      recognition: judgment.recognition,
      openAsks: judgment.openAsks,
      friction: judgment.friction,
      raiseWithManager: judgment.raiseWithManager,
      reflection: judgment.reflection,
      coverage: weekCoverage(updated),
      evidence: updated.flatMap((d) => d.evidence),
      frameworkId: framework.id,
      areasSnapshot: framework.areas.map((a) => ({ key: a.key, label: a.label })),
      plan: Array.isArray(ext.plan) ? (ext.plan as WorkWeek["plan"]) : [],
      ext,
    };
    await saveWeek(record);
    deps.notify();

    // 5. Feature hooks (a failing hook is logged by runWeekHooks and never fails the run).
    for (const day of updated) await runDayHooks(registry, day, ctx);
    await runWeekHooks(registry, record, ctx);
    deps.notify();
  }

  const weekOptions = new Map<string, WeekRunOptions>();

  // ─── queueing ──────────────────────────────────────────────────────────────

  async function runDay(date: string): Promise<void> {
    await validateDay(date);
    return queue.enqueue(`day:${date}`, (setStep) => runDayTask(date, setStep));
  }

  async function runWeek(week: string, opts: { recapture?: boolean; recaptureToday?: boolean } = {}): Promise<void> {
    validateWeek(week);
    const key = `week:${week}`;
    const wanted: WeekRunOptions = { recapture: opts.recapture === true, recaptureToday: opts.recaptureToday === true };
    const upgrade = wanted.recapture || wanted.recaptureToday;
    const state = queue.state(key);
    const existing = weekOptions.get(key);
    // Joining a run that has not started upgrades it; joining one already running only helps if it needs nothing more.
    if (state === "waiting" && existing !== undefined) weekOptions.set(key, { recapture: existing.recapture || wanted.recapture, recaptureToday: existing.recaptureToday || wanted.recaptureToday });
    else if (state === "idle" || (state === "running" && upgrade)) weekOptions.set(key, wanted);
    return queue.enqueue(
      key,
      (setStep) => {
        const options = weekOptions.get(key) ?? { recapture: false, recaptureToday: false };
        weekOptions.delete(key);
        return runWeekTask(week, options, setStep);
      },
      { afterRunning: upgrade },
    );
  }

  const clampWeeks = (n: number | undefined, fallback: number) => Math.min(MAX_BACKFILL_WEEKS, Math.max(1, Math.floor(Number.isFinite(n) ? (n as number) : fallback)));
  const background = (week: string, label: string, opts?: { recapture?: boolean; recaptureToday?: boolean }) => void runWeek(week, opts).catch((cause: unknown) => warn(`${label} ${week}`, cause));

  /** Queue the `n` most recent finished weeks, oldest first. Returns immediately with the week keys. */
  async function backfill(n = 4, opts: { force?: boolean } = {}): Promise<string[]> {
    const count = clampWeeks(n, 4);
    const t = today();
    const current = isoWeekOf(t);
    const finished = [...previousWeeks(current, count + 1), current].filter((w) => weekDates(w)[4]! < t).slice(-count);
    const index = await readIndex();
    const queued: string[] = [];
    for (const week of finished) {
      if (opts.force !== true && index.weeks[week]?.final === true) continue;
      queued.push(week);
      background(week, "backfill");
    }
    return queued;
  }

  /** Queue the last `n` weeks (current included) that have a missing day, a failed source or no final judgment yet. */
  async function fillGaps(n: number): Promise<string[]> {
    const count = clampWeeks(n, 4);
    const t = today();
    const current = isoWeekOf(t);
    const index = await readIndex();
    const queued: string[] = [];
    for (const week of [...previousWeeks(current, count - 1), current]) {
      const all = weekDates(week);
      const past = all.filter((d) => d <= t);
      if (past.length === 0) continue;
      const missingOrFailed = past.some((d) => {
        const entry = index.days[d];
        return entry === undefined || entry.worstCoverage === "failed" || Object.values(entry.coverage).includes("failed");
      });
      const unjudged = all[4]! < t && index.weeks[week]?.final !== true;
      if (!missingOrFailed && !unjudged) continue;
      queued.push(week);
      background(week, "fill gaps");
    }
    return queued;
  }

  // Two overlapping ticks (a slow tick plus the next 10-minute fire) must not both read an unwritten slot.
  let tickInFlight: Promise<void> | null = null;
  function scheduledTick(): Promise<void> {
    if (tickInFlight !== null) return tickInFlight;
    const run = tickOnce().finally(() => {
      if (tickInFlight === run) tickInFlight = null;
    });
    tickInFlight = run;
    return run;
  }

  async function tickOnce(): Promise<void> {
    if (!settings().enabled || !(await deps.onboarded())) return;
    const s = settings();
    const at = now();
    const t = localToday(at, s.timeZone);
    const currentWeek = isoWeekOf(t);

    // One attempt per slot, success or not: the slot is written BEFORE the run starts, and runs are not awaited, so a
    // second tick (they fire every 10 minutes) can never queue the same run again. Failures land in the queue's lastError.
    const weekly = dueRefreshSlot({ now: at, timeZone: s.timeZone, cronExpr: s.weeklyCron, lastSlot: await store.getMeta(WORKLOG_WEEKLY_SLOT_KEY), maxLateMs: WORKLOG_MAX_LATE_MS });
    if (weekly !== null) {
      await store.setMeta(WORKLOG_WEEKLY_SLOT_KEY, weekly);
      background(currentWeek, "weekly", { recaptureToday: true });
    }

    const daily = dueRefreshSlot({ now: at, timeZone: s.timeZone, cronExpr: s.dailyCron, lastSlot: await store.getMeta(WORKLOG_DAILY_SLOT_KEY), maxLateMs: WORKLOG_MAX_LATE_MS });
    if (daily !== null) {
      await store.setMeta(WORKLOG_DAILY_SLOT_KEY, daily);
      const index = await readIndex();
      const prev = previousWeeks(currentWeek, 1)[0]!;
      // The Friday run was missed (server down): finish last week first.
      if (index.weeks[prev]?.final !== true && weekDates(prev).some((d) => index.days[d] !== undefined)) {
        const attempts = Number(await store.getMeta(catchupKey(prev))) || 0;
        if (attempts < MAX_CATCHUP_ATTEMPTS) {
          await store.setMeta(catchupKey(prev), String(attempts + 1));
          background(prev, "catch-up");
        } else if (attempts === MAX_CATCHUP_ATTEMPTS) {
          warn(`catch-up ${prev}`, `gave up after ${MAX_CATCHUP_ATTEMPTS} attempts; run the week by hand`);
          await store.setMeta(catchupKey(prev), String(attempts + 1));
        }
      }
      // A week run in flight (or just queued) covers today; the day task would only bounce off the final week.
      if (queue.state(`week:${currentWeek}`) === "idle" && index.weeks[currentWeek]?.final !== true) {
        void runDay(t).catch((cause: unknown) => warn(`daily ${t}`, cause));
      }
    }

    // Feature tick hooks (auto-planning). Not awaited: a model job must not hold the tick, and each hook guards itself.
    void runTickHooks(registry, ctx);
  }

  // ─── import / rebuild ──────────────────────────────────────────────────────

  async function rebuildIndex(): Promise<void> {
    await withIndexLock(async () => {
      const index = emptyIndex();
      for (const row of await store.list(KIND.day, workDaySchema)) index.days[row.id] = indexDay({ ...row.value, coverage: withAllSources(row.value.coverage) });
      for (const row of await store.list(KIND.week, workWeekSchema)) index.weeks[row.id] = { rating: row.value.rating, final: row.value.final, generatedAt: row.value.generatedAt };
      prune(index);
      await store.set(KIND.index, INDEX_ID, index);
    });
    deps.notify();
  }

  async function replayWeekHooks(weeks?: string[]): Promise<number> {
    const records = weeks === undefined ? (await store.list(KIND.week, workWeekSchema)).map((r) => r.value) : (await Promise.all([...weeks].sort().map(getWeek))).filter((w): w is WorkWeek => w !== null);
    let count = 0;
    for (const record of records.sort((a, b) => (a.week < b.week ? -1 : a.week > b.week ? 1 : 0))) {
      await runWeekHooks(registry, record, ctx);
      count += 1;
    }
    return count;
  }

  // ─── public API ────────────────────────────────────────────────────────────

  return {
    async grid(weeks): Promise<GridV2> {
      const s = settings();
      const framework = await deps.framework();
      const grid = buildGrid(await readIndex(), today(), weeks ?? s.gridWeeks, queue.status(), {
        areas: framework.areas.map((a) => ({ key: a.key, label: a.label })),
        timeZone: s.timeZone,
        workdayHours: s.workdayHours,
      });
      await runGridContributors(registry, grid, ctx);
      return grid;
    },
    day: getDay,
    week: getWeek,
    async weekFinal(week) {
      return (await readIndex()).weeks[week]?.final === true;
    },
    async weekMarkdown(week) {
      const record = await getWeek(week);
      if (record === null) throw new Error(`No report for ${week} yet`);
      const addenda = await store.get(KIND.addenda, week, weekAddendaSchema);
      const markdown = weekMarkdown(record, addenda?.myNotes ?? "", { framework: await deps.framework(), timeZone: tz() });
      return { markdown, filename: `${week}.md` };
    },
    index: readIndex,
    async run(input) {
      switch (input.kind) {
        case "day": {
          await validateDay(input.date);
          void runDay(input.date).catch((cause: unknown) => warn(`day ${input.date}`, cause));
          return;
        }
        case "week": {
          validateWeek(input.week);
          background(input.week, "week", { recapture: input.recapture === true });
          return;
        }
        case "backfill": {
          await backfill(input.weeks ?? 4, { force: input.force === true });
          return;
        }
        case "fill_gaps": {
          await fillGaps(input.weeks);
          return;
        }
        default:
          throw new Error(`Unknown run kind: ${JSON.stringify((input as { kind?: unknown }).kind)}`);
      }
    },
    async runDayNow(date) {
      await runDay(date);
      const day = await getDay(date);
      if (day === null) throw new Error(`No data for ${date}`);
      return day;
    },
    async runWeekNow(week, recapture = false) {
      await runWeek(week, { recapture });
      const record = await getWeek(week);
      if (record === null) throw new Error(`No report for ${week}`);
      return record;
    },
    status: (): WorklogStatus => queue.status(),
    scheduledTick,
    rebuildIndex,
    async importDay(day) {
      await saveDay(workDaySchema.parse(day));
      deps.notify();
    },
    async importWeek(week) {
      await saveWeek(workWeekSchema.parse(week));
      deps.notify();
    },
    replayWeekHooks,
  };
}
