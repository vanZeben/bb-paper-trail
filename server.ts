// Paper Trail — backend entry.
//
// An evidence-backed record of your engineering work. Hidden agent threads on a bb host read your connectors (the
// plugin holds no credentials), the engine rates each workday and judges each week, and this file wires the engine,
// the storage, the feature modules, the RPC contract and the CLI together.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { rpcContract } from "./lib/contract";
import { CHANNEL, PLUGIN_ID } from "./lib/meta";
import { cronProblems, DEFAULT_SETTINGS, type Settings } from "./lib/settings";
import { MAX_BACKFILL_WEEKS, connectorCheckSchema, dateStr, roleFrameworkSchema, weekStr, type RoleFramework } from "./lib/types";
import { writeFile } from "node:fs/promises";
import { isSourceId } from "./lib/capture/sources";
import { createRegistry, FEATURE_ORDER, type FeatureCtx, type FeatureId, type Registry } from "./lib/engine/extensions";
import { createPool, createRunner, type Log } from "./lib/engine/runner";
import { createWorklogService } from "./lib/engine/service";
import { DEFAULT_FRAMEWORK } from "./lib/framework/default";
import { openDatabase } from "./lib/storage/db";
import { KIND } from "./lib/storage/port";
import { createSqliteStore } from "./lib/storage/store";
import { createWorker } from "./lib/worker";
import * as core from "./lib/handlers/core";
import * as connectorsHandlers from "./lib/handlers/connectors";
import * as driftHandlers from "./lib/handlers/drift";
import * as frameworkHandlers from "./lib/handlers/framework";
import * as ghostHandlers from "./lib/handlers/ghost";
import * as guardrailsHandlers from "./lib/handlers/guardrails";
import * as migrateHandlers from "./lib/handlers/migrate";
import * as overridesHandlers from "./lib/handlers/overrides";
import * as packetHandlers from "./lib/handlers/packet";
import * as setupHandlers from "./lib/handlers/setup";
import * as planHandlers from "./lib/handlers/plan";
import * as threadsHandlers from "./lib/handlers/threads";
import type { HandlerEnv, RpcHandlers } from "./lib/handlers/types";
import { runConnectorCheck } from "./lib/features/connectors/check";
import { exportBundle } from "./lib/features/migrate/export";
import { packetDoc } from "./lib/features/packet/service";
import { register as registerConnectors } from "./lib/features/connectors";
import { register as registerDrift } from "./lib/features/drift";
import { register as registerFramework } from "./lib/features/framework";
import { register as registerGhost } from "./lib/features/ghost";
import { register as registerGoals } from "./lib/features/goals";
import { register as registerGuardrails } from "./lib/features/guardrails";
import { register as registerMigrate } from "./lib/features/migrate";
import { register as registerOverrides } from "./lib/features/overrides";
import { register as registerPacket } from "./lib/features/packet";
import { register as registerPlan } from "./lib/features/plan";
import { register as registerThreads } from "./lib/features/threads";

export { rpcContract };

/** Registered in FEATURE_ORDER, so hooks and contributors run in that order. */
const FEATURES: Record<FeatureId, (reg: Registry) => void> = {
  connectors: registerConnectors,
  framework: registerFramework,
  overrides: registerOverrides,
  goals: registerGoals,
  plan: registerPlan,
  drift: registerDrift,
  threads: registerThreads,
  guardrails: registerGuardrails,
  ghost: registerGhost,
  packet: registerPacket,
  migrate: registerMigrate,
};

/** The schedule tick; the cron slots inside the service decide what is due. */
const TICK_CRON = "*/10 * * * *";
const MINUTE = 60_000;
/** CLI flags that take a value (their value is not a positional argument). */
const VALUE_FLAGS = ["--weeks", "--out", "--from", "--to"];
/** The most a CLI command prints to stdout; bigger results need --out. */
const MAX_STDOUT = 200_000;

const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
const clip = (text: string, max = 200): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const validZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

/** `enabledSources` is stored as a JSON array in a multiline field. Unparseable input falls back to all sources. */
function parseSources(raw: string): Settings["enabledSources"] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return [...new Set(parsed.filter(isSourceId))];
  } catch {
    // fall through
  }
  return [...DEFAULT_SETTINGS.enabledSources];
}

export default async function plugin(bb: BbPluginApi) {
  const D = DEFAULT_SETTINGS;
  const settingsHandle = bb.settings.define({
    enabled: {
      type: "boolean",
      label: "Scheduled capture",
      description: "Capture each finished workday and judge each week on a schedule. On-demand runs and the CLI work either way.",
      default: D.enabled,
    },
    timeZone: { type: "string", label: "Time zone", description: "IANA zone for every date, prompt and schedule (e.g. America/New_York).", default: D.timeZone },
    captureHost: { type: "string", label: "Capture host", description: "Name of the bb host (machine) that runs the capture threads and holds your connectors. Empty uses the primary host.", default: D.captureHost },
    providerId: { type: "string", label: "Agent provider", description: "Provider id for the capture threads. Empty uses the bb default.", default: D.providerId },
    captureModel: { type: "string", label: "Capture model", description: "Model for capture, the daily rating and the connector check. Empty uses the thread default.", default: D.captureModel },
    judgeModel: { type: "string", label: "Judgment model", description: "Model for the weekly judgment, narratives and framework import. Empty uses the thread default.", default: D.judgeModel },
    workerPermissionMode: {
      type: "select",
      label: "Worker permission mode",
      description: "Permission mode of the hidden capture threads that read your connectors. \"auto\" lets the thread approve routine tool calls itself; \"accept-edits\" is stricter and may stop capture at an approval prompt. Jobs that need no tools always use the strictest mode.",
      options: ["auto", "accept-edits"],
      default: D.workerPermissionMode,
    },
    maxParallel: { type: "number", label: "Parallel jobs", description: "How many capture jobs may run at once.", default: D.maxParallel },
    captureTimeoutMinutes: { type: "number", label: "Capture timeout (minutes)", description: "How long one capture job may run.", default: D.captureTimeoutMinutes },
    judgeTimeoutMinutes: { type: "number", label: "Judgment timeout (minutes)", description: "How long the weekly judgment may run.", default: D.judgeTimeoutMinutes },
    dailyCron: { type: "string", label: "Daily capture time", description: "When the day is captured and provisionally rated, in your time zone (minute hour * * weekdays).", default: D.dailyCron },
    weeklyCron: { type: "string", label: "Weekly judgment time", description: "When the week is judged, in your time zone (minute hour * * weekday).", default: D.weeklyCron },
    workdayHours: { type: "number", label: "Working day hours", description: "Length of a working day, for the meeting share of a week.", default: D.workdayHours },
    enabledSources: {
      type: "string",
      label: "Enabled sources",
      description: 'JSON array of the sources you allow, e.g. ["calendar","jira","github"]. The connector check can still mark an allowed source unavailable.',
      experimental_multiline: true,
      default: JSON.stringify(D.enabledSources),
    },
    githubOrg: { type: "string", label: "GitHub organization", description: "Optional: scope GitHub activity to one organization. Empty searches everywhere you have access.", default: D.githubOrg },
    watchedChannels: { type: "string", label: "Watched chat channels", description: "Comma-separated channels whose posts are always captured.", default: D.watchedChannels },
    jiraSiteUrl: { type: "string", label: "Jira site URL", description: "Optional: used only to build links when the tracker returns none.", default: D.jiraSiteUrl },
    notesSkipFolders: { type: "string", label: "Notes folders to skip", description: "Comma-separated notes folders to leave out (machine-generated folders would double-count).", default: D.notesSkipFolders },
    notesFolder: { type: "string", label: "Notes folder", description: "Folder in your notes vault that review-packet notes may be written to. Empty disables writing notes.", default: D.notesFolder },
    gridWeeks: { type: "number", label: "Weeks on the graph", description: "How many weeks the graph shows (4 to 52).", default: D.gridWeeks },
  });

  const log: Log = { info: (message) => bb.log.info(message), warn: (message) => bb.log.warn(message) };

  const toSettings = (v: Awaited<ReturnType<typeof settingsHandle.get>>): Settings => ({
    enabled: v.enabled,
    timeZone: v.timeZone.trim() !== "" && validZone(v.timeZone.trim()) ? v.timeZone.trim() : D.timeZone,
    captureHost: v.captureHost.trim(),
    providerId: v.providerId.trim(),
    captureModel: v.captureModel.trim(),
    judgeModel: v.judgeModel.trim(),
    workerPermissionMode: v.workerPermissionMode === "accept-edits" ? "accept-edits" : "auto",
    maxParallel: Math.max(1, Math.floor(v.maxParallel) || D.maxParallel),
    captureTimeoutMinutes: Math.max(1, v.captureTimeoutMinutes || D.captureTimeoutMinutes),
    judgeTimeoutMinutes: Math.max(1, v.judgeTimeoutMinutes || D.judgeTimeoutMinutes),
    dailyCron: v.dailyCron.trim() || D.dailyCron,
    weeklyCron: v.weeklyCron.trim() || D.weeklyCron,
    workdayHours: v.workdayHours > 0 ? v.workdayHours : D.workdayHours,
    enabledSources: parseSources(v.enabledSources),
    githubOrg: v.githubOrg.trim(),
    watchedChannels: v.watchedChannels,
    jiraSiteUrl: v.jiraSiteUrl.trim(),
    notesSkipFolders: v.notesSkipFolders,
    notesFolder: v.notesFolder.trim(),
    gridWeeks: Math.min(52, Math.max(4, Math.floor(v.gridWeeks) || D.gridWeeks)),
  });

  // A synchronous typed getter for everything downstream; refreshed whenever a settings write lands.
  const load = (v: Awaited<ReturnType<typeof settingsHandle.get>>): Settings => {
    // "full" was offered by an earlier build; hidden threads read third-party text, so it is no longer honoured.
    if ((v.workerPermissionMode as string) === "full") log.warn('worker permission mode "full" is no longer supported; using "auto"');
    const next = toSettings(v);
    const problems = cronProblems(next);
    for (const problem of problems) log.warn(problem);
    if (problems.length > 0) bb.status.needsConfiguration(problems.join(" "));
    return next;
  };
  let current = load(await settingsHandle.get());
  settingsHandle.onChange((next) => {
    current = load(next);
  });
  const settings = (): Settings => current;

  const notify = () => bb.realtime.publish(CHANNEL, { at: Date.now() });

  // ─── storage, worker, runner ─────────────────────────────────────────────
  const db = openDatabase(bb);
  const store = createSqliteStore(db, log);
  const worker = createWorker({ sdk: bb.sdk, settings, log });
  const pool = createPool(() => settings().maxParallel);
  const runner = createRunner({
    worker,
    pool,
    defaultTimeoutMs: () => settings().captureTimeoutMinutes * MINUTE,
    defaultModel: () => settings().captureModel || undefined,
    log,
  });

  // ─── features ────────────────────────────────────────────────────────────
  const registry = createRegistry();
  for (const id of FEATURE_ORDER) FEATURES[id](registry);

  const framework = async (): Promise<RoleFramework> => (await store.get(KIND.framework, "active", roleFrameworkSchema)) ?? DEFAULT_FRAMEWORK;
  const connectors = () => store.get(KIND.connectors, "latest", connectorCheckSchema);
  const onboarded = () => core.isOnboarded(store);

  const ctx: FeatureCtx = { store, settings, framework, runner, log, publish: notify, now: () => new Date() };

  const service = createWorklogService({ store, runner, registry, ctx, settings, framework, connectors, onboarded, notify, log });

  const env: HandlerEnv = {
    worker,
    enableSchedule: async () => {
      await settingsHandle.experimental_set({ enabled: true });
    },
    hosts: async () => {
      const hosts = await bb.sdk.hosts.list();
      return hosts.map((h) => ({ id: h.id, name: h.name, connected: h.status === "connected" }));
    },
  };

  // ─── RPC ─────────────────────────────────────────────────────────────────
  const rpcHandlers: RpcHandlers = {
    ...core.handlers(ctx, service, env),
    ...connectorsHandlers.handlers(ctx, service, env),
    ...frameworkHandlers.handlers(ctx, service, env),
    ...driftHandlers.handlers(ctx, service, env),
    ...guardrailsHandlers.handlers(ctx, service, env),
    ...overridesHandlers.handlers(ctx, service, env),
    ...planHandlers.handlers(ctx, service, env),
    ...threadsHandlers.handlers(ctx, service, env),
    ...ghostHandlers.handlers(ctx, service, env),
    ...packetHandlers.handlers(ctx, service, env),
    ...migrateHandlers.handlers(ctx, service, env),
    ...setupHandlers.handlers(ctx, service, env),
  };
  bb.rpc.register(rpcContract, rpcHandlers);

  // ─── schedule ────────────────────────────────────────────────────────────
  // One frequent tick; the service works out from the daily/weekly cron slots (in the configured zone) what is due.
  bb.background.schedule(`${PLUGIN_ID}-check`, TICK_CRON, async () => {
    try {
      await service.scheduledTick();
    } catch (cause) {
      log.warn(`scheduled tick failed: ${errorMessage(cause)}`);
    }
  });

  // ─── CLI ─────────────────────────────────────────────────────────────────
  const cli = (name: string) => `bb ${PLUGIN_ID} ${name}`;
  const usage = [
    "Usage:",
    `  ${cli("status")} [--json]                              run/queue status`,
    `  ${cli("day <YYYY-MM-DD>")} [--json]                    capture and provisionally rate one day (waits)`,
    `  ${cli("week <YYYY-Www>")} [--recapture] [--json]       judge a week (waits)`,
    `  ${cli("backfill")} [--weeks N] [--force]               queue the last N finished weeks (default 4)`,
    `  ${cli("doctor")}                                       check that a capture thread can run`,
    `  ${cli("connectors")} [--check] [--json]                show the connector check (--check runs a fresh one and waits)`,
    `  ${cli("packet <from> <to>")} [--out FILE]              review packet as markdown (dates YYYY-MM-DD)`,
    `  ${cli("export")} [--from DATE --to DATE] [--out FILE]  data bundle as JSON`,
  ].join("\n");

  bb.cli.register({
    name: PLUGIN_ID,
    summary: "Evidence-backed record of your engineering work",
    commands: [
      { name: "status", summary: "Run and queue status", usage: cli("status [--json]") },
      { name: "day", summary: "Capture and rate one day", usage: cli("day <YYYY-MM-DD> [--json]") },
      { name: "week", summary: "Judge one week", usage: cli("week <YYYY-Www> [--recapture] [--json]") },
      { name: "backfill", summary: "Queue the last finished weeks", usage: cli("backfill [--weeks N] [--force]") },
      { name: "doctor", summary: "Check that the capture host can run a job", usage: cli("doctor") },
      { name: "connectors", summary: "Show which sources the capture host can reach", usage: cli("connectors [--check] [--json]") },
      { name: "packet", summary: "Review packet for a date range, as markdown", usage: cli("packet <from> <to> [--out FILE]") },
      { name: "export", summary: "Export your data as a JSON bundle", usage: cli("export [--from DATE --to DATE] [--out FILE]") },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const flagValue = (flag: string) => {
        const at = argv.indexOf(flag);
        return at === -1 ? undefined : argv[at + 1];
      };
      const positional = argv.filter((arg, at) => !arg.startsWith("--") && !VALUE_FLAGS.includes(argv[at - 1] ?? ""));
      const [command, arg] = positional;
      const out = (value: unknown, text: string) => ({ exitCode: 0, stdout: json ? JSON.stringify(value) : text });
      try {
        switch (command) {
          case undefined:
          case "help":
            return { exitCode: 0, stdout: usage };
          case "status": {
            const status = service.status();
            const lines = [
              status.running ? `running ${status.running.key}${status.running.step ? ` (${status.running.step})` : ""} since ${status.running.startedAt}` : "idle",
              `queued: ${clip(status.queued.join(", ") || "none", 300)}`,
              status.lastError ? `last error: ${status.lastError.key} at ${status.lastError.at}: ${clip(status.lastError.message, 300)}` : "last error: none",
            ];
            return out(status, lines.join("\n"));
          }
          case "day": {
            if (arg === undefined || !dateStr.safeParse(arg).success) return { exitCode: 1, stderr: `Expected a date like 2026-11-12.\n${usage}` };
            const day = await service.runDayNow(arg);
            return out(
              day,
              day.rating ? `${arg}: ${day.rating.rating}${day.rating.provisional ? " (provisional)" : ""} - ${clip(day.rating.reason)}` : `${arg}: captured, not rated.`,
            );
          }
          case "week": {
            if (arg === undefined || !weekStr.safeParse(arg).success) return { exitCode: 1, stderr: `Expected a week like 2026-W46.\n${usage}` };
            const week = await service.runWeekNow(arg, argv.includes("--recapture"));
            return out(week, `${arg}: ${week.rating}${week.final ? "" : " (not final)"} - ${clip(week.ratingReason, 300)}`);
          }
          case "backfill": {
            const raw = flagValue("--weeks");
            const weeks = raw === undefined ? 4 : Number.parseInt(raw, 10);
            if (!Number.isFinite(weeks) || weeks < 1 || weeks > MAX_BACKFILL_WEEKS) return { exitCode: 1, stderr: `--weeks must be 1 to ${MAX_BACKFILL_WEEKS}.` };
            await service.run({ kind: "backfill", weeks, force: argv.includes("--force") });
            notify();
            return out({ queued: true, weeks }, `Backfill of up to ${weeks} weeks queued. Check progress with: ${cli("status")}`);
          }
          case "doctor": {
            const ping = await worker.ping();
            const text = ping.ok
              ? `ok: a capture thread ran on ${ping.hostName ?? ping.hostId ?? "the capture host"}${ping.reply ? ` (reply: ${clip(ping.reply, 80)})` : ""}`
              : `failed: ${clip(ping.error ?? "unknown error", 300)}`;
            return { exitCode: ping.ok ? 0 : 1, stdout: json ? JSON.stringify(ping) : text };
          }
          case "connectors": {
            const check = argv.includes("--check") ? await runConnectorCheck(ctx, env.hosts) : await store.get(KIND.connectors, "latest", connectorCheckSchema);
            if (check === null) return out(null, `No connector check yet. Run: ${cli("connectors --check")}`);
            const lines = [
              `checked ${check.checkedAt} on ${check.hostName}${check.model ? ` (${check.model})` : ""}`,
              ...Object.entries(check.sources).map(([id, s]) => {
                const state = s.available === null ? "unknown" : s.available ? "available" : "unavailable";
                return clip(`${id}: ${state}${s.via ? ` via ${s.via}` : ""}${s.account ? ` as ${s.account}` : ""}${s.note ? ` - ${s.note}` : ""}`, 200);
              }),
            ];
            return out(check, lines.join("\n"));
          }
          case "packet": {
            const [, from, to] = positional;
            if (from === undefined || to === undefined || !dateStr.safeParse(from).success || !dateStr.safeParse(to).success || from > to) {
              return { exitCode: 1, stderr: `Expected two dates, from <= to, like 2026-01-01 2026-06-30.\n${usage}` };
            }
            const doc = await packetDoc(ctx, { from, to }, false);
            const target = flagValue("--out");
            if (target !== undefined) {
              await writeFile(target, doc.markdown, "utf8");
              return out({ wrote: target, bytes: doc.markdown.length }, `Wrote ${doc.markdown.length} characters to ${target}`);
            }
            if (doc.markdown.length > MAX_STDOUT) return { exitCode: 1, stderr: `The packet is ${doc.markdown.length} characters; use --out FILE.` };
            return { exitCode: 0, stdout: json ? JSON.stringify(doc) : doc.markdown };
          }
          case "export": {
            const from = flagValue("--from");
            const to = flagValue("--to");
            if ((from !== undefined && !dateStr.safeParse(from).success) || (to !== undefined && !dateStr.safeParse(to).success)) return { exitCode: 1, stderr: `--from and --to take a date like 2026-11-12.\n${usage}` };
            const bundle = await exportBundle(ctx, { from, to });
            const text = JSON.stringify(bundle);
            const target = flagValue("--out");
            const counts = `${bundle.days.length} days, ${bundle.weeks.length} weeks, ${bundle.records?.length ?? 0} records`;
            if (target !== undefined) {
              await writeFile(target, text, "utf8");
              return out({ wrote: target, bytes: text.length }, `Wrote ${counts} to ${target}`);
            }
            if (text.length > MAX_STDOUT) return { exitCode: 1, stderr: `The bundle is ${text.length} characters (${counts}); use --out FILE.` };
            return { exitCode: 0, stdout: text };
          }
          default:
            return { exitCode: 1, stderr: usage };
        }
      } catch (cause) {
        return { exitCode: 1, stderr: clip(errorMessage(cause), 500) };
      }
    },
  });

  bb.onDispose(() => log.info("disposed"));

  log.info(`loaded (zone ${settings().timeZone}, sources ${settings().enabledSources.join(",") || "none"})`);
  if (settings().enabledSources.length === 0) {
    bb.status.needsConfiguration('No sources are enabled. Set "Enabled sources" in the plugin settings (a JSON array such as ["calendar","github"]).');
  }
}
