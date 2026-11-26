/**
 * settings.ts — the typed settings shape. server.ts defines these with `bb.settings.define` (same keys, same
 * defaults) and passes a `() => Settings` getter to everything else; no other module touches the SDK settings API.
 * No secret settings: the plugin holds no credentials.
 */
import { isSupportedCron } from "./engine/schedule";
import type { SourceId } from "./types";

export interface Settings {
  /** Scheduled capture on/off. On by default; the scheduled tick still waits for onboarding to complete. */
  enabled: boolean;
  /** IANA zone for every date, prompt and schedule. Default: the server's Intl zone. */
  timeZone: string;
  /** bb host (machine) name the hidden capture threads run on. Empty = the primary host. */
  captureHost: string;
  /** Agent provider id for worker threads. Empty = bb default. */
  providerId: string;
  /** Model for capture, day rating and the connector check. Empty = thread default. */
  captureModel: string;
  /** Model for the week judgment, narratives and role-doc import. Empty = thread default. */
  judgeModel: string;
  /**
   * Permission mode of the capture threads (those that need connector tools). "full" is deliberately not offered: the
   * threads read third-party text (tickets, chat, pages) that may carry injected instructions. A stored "full" is
   * treated as "auto". Jobs that need no tools always run in the most restrictive mode, whatever this says.
   */
  workerPermissionMode: "auto" | "accept-edits";
  maxParallel: number;
  captureTimeoutMinutes: number;
  judgeTimeoutMinutes: number;
  /** Cron in `timeZone`: daily capture of the finished workday. */
  dailyCron: string;
  /** Cron in `timeZone`: weekly judgment. */
  weeklyCron: string;
  workdayHours: number;
  /** Sources the user allows; the connector check can still mark an allowed source unavailable (coverage "off"). */
  enabledSources: SourceId[];
  /** Optional GitHub org to scope the search; empty drops the `org:` qualifier. */
  githubOrg: string;
  /** Comma-separated chat channels whose posts are always captured (kind "watched_channel"). */
  watchedChannels: string;
  /** Optional Jira site URL, only for building links when the tool returns none. */
  jiraSiteUrl: string;
  /** Comma-separated notes folders to skip (machine-generated folders would double-count). */
  notesSkipFolders: string;
  /** Notes folder the review-packet note write is confined to. Empty = writing a note is refused. */
  notesFolder: string;
  gridWeeks: number;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  captureHost: "",
  providerId: "",
  captureModel: "",
  judgeModel: "",
  workerPermissionMode: "auto",
  maxParallel: 2,
  captureTimeoutMinutes: 10,
  judgeTimeoutMinutes: 15,
  dailyCron: "45 17 * * 1-5",
  weeklyCron: "0 18 * * 5",
  workdayHours: 8,
  enabledSources: ["calendar", "granola", "fellow", "jira", "confluence", "github", "slack", "vault", "memory"],
  githubOrg: "",
  watchedChannels: "",
  jiraSiteUrl: "",
  notesSkipFolders: "",
  notesFolder: "",
  gridWeeks: 36,
};

export const splitList = (s: string): string[] =>
  s
    .split(",")
    .map((x) => x.trim().replace(/^#/, ""))
    .filter(Boolean);

/** Human-readable problems with the schedule settings (empty when both crons are understood). */
export function cronProblems(s: Pick<Settings, "dailyCron" | "weeklyCron">): string[] {
  const problems: string[] = [];
  if (!isSupportedCron(s.dailyCron)) problems.push(`Daily capture schedule '${s.dailyCron}' isn't understood; use e.g. 45 17 * * 1-5`);
  if (!isSupportedCron(s.weeklyCron)) problems.push(`Weekly judgment schedule '${s.weeklyCron}' isn't understood; use e.g. 0 18 * * 5`);
  return problems;
}
