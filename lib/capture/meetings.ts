/**
 * meetings.ts — one day of calendar + meeting-notes (Granola, Fellow), fetched by a read-only worker.
 * Rule: every timed event the user did not explicitly decline counts as attended.
 * A disabled note source is never asked about and yields `off` coverage.
 */
import { dayBounds } from "../engine/dates";
import type { Job } from "../engine/runner";
import { withIdentity } from "./identity";
import { MAX_OUTCOME, MAX_WHAT, clip, type Coverage, type RawEntry, type WorkMeeting, type Identity } from "../types";
import { CAPTURE_RULES, OFF, coverageOf, httpsLink, isRec, optString } from "./common";
import { kindsFor } from "./sources";

export const MAX_MEETINGS = 25;
export const MAX_CONTRIBUTIONS = 8;
const RESPONSES = ["accepted", "tentative", "needsAction", "organizer"] as const;

export type NoteSource = "granola" | "fellow";

export interface MeetingNote {
  title: string;
  start: string | null;
  passive: boolean;
}
export interface NotesPart {
  coverage: Coverage;
  entries: RawEntry[];
  notes: MeetingNote[];
}
export interface MeetingsCapture {
  calendar: { coverage: Coverage; meetings: Array<Omit<WorkMeeting, "id">> };
  /** Granola meeting notes. `off` when the source is not enabled. */
  granola: NotesPart;
  /** Fellow AI meeting summaries: covers meetings the other note source missed. `off` when not enabled. */
  fellow: NotesPart;
}

export interface MeetingsOptions {
  /** Who the user is; adds a line to the prompt so transcripts and handles are credited to them. */
  identity?: Identity | undefined;
  timeZone: string;
  noteSources: readonly NoteSource[];
}

/** `opts.identity` adds who the user is to the prompt (see identity.ts). */
export function meetingsJob(date: string, opts: MeetingsOptions): Job<MeetingsCapture> {
  return withIdentity(meetingsJobBase(date, opts), opts.identity);
}

function meetingsJobBase(date: string, opts: MeetingsOptions): Job<MeetingsCapture> {
  const { timeZone } = opts;
  const granola = opts.noteSources.includes("granola");
  const fellow = opts.noteSources.includes("fellow");
  const toolList = ["calendar read tools", ...(granola ? ["the Granola meeting-notes read tools"] : []), ...(fellow ? ["the Fellow meeting-notes read tools"] : [])];
  const contributionText = `Keep ONLY what the user themself contributed: decisions they shaped, proposals they made, commitments they took, help they gave or asked for, recognition they gave or received. One short line each (kind: decision | proposal | commitment | help_given | help_asked | recognition) plus the visible outcome. If they only attended, set passive:true and contributions:[]. At most ${MAX_CONTRIBUTIONS} contributions per meeting.`;

  const steps: string[] = [
    `Calendar: with the calendar read tools (e.g. a list-events tool), list the signed-in user's PRIMARY calendar events on ${date} (${timeZone}). INCLUDE every timed event the user did not explicitly decline (accepted, tentative, no response and organizer all count as attended). EXCLUDE declined events, all-day events and cancelled events. For each give title, start and end (ISO 8601 with UTC offset), response ("accepted" | "tentative" | "needsAction" | "organizer"), attendees (count, or null) and url (or null). At most ${MAX_MEETINGS}.`,
  ];
  if (granola) {
    steps.push(`Granola: with the Granola meeting-notes read tools, read the note/summary of each meeting on ${date}. ${contributionText}`);
  }
  if (fellow) {
    const dedupe = granola ? " SKIP any meeting already covered by a Granola note in the previous step, so nothing is counted twice." : "";
    steps.push(
      `Fellow: with the Fellow meeting-notes read tools (e.g. a meeting search and a get-meeting-summary tool), find meetings on ${date} that have a calendar event and a summary, and read each summary.${dedupe} Also SKIP meetings the user declined on their calendar: Fellow shares notes with invitees who did not attend. Extract the user's own contributions exactly as above (same kinds, passive:true when they only attended). Fellow summaries name speakers; only credit what the summary attributes to the user. If Fellow has no meetings that day, reply available:true with meetings:[].${granola ? "" : ` ${contributionText}`}`,
    );
  }

  const sections = [
    `"calendar":{"available":true,"note":null,"events":[{"title":"Design review","start":"${date}T14:00:00-05:00","end":"${date}T15:00:00-05:00","response":"needsAction","attendees":7,"url":null}]}`,
    ...(granola
      ? [`"granola":{"available":true,"note":null,"meetings":[{"title":"Design review","start":"${date}T14:00:00-05:00","passive":false,"url":null,"contributions":[{"kind":"decision","what":"Vouched for the API gateway design with one condition","outcome":"Approved pending rate-limit section"}]}]}`]
      : []),
    ...(fellow
      ? [`"fellow":{"available":true,"note":null,"meetings":[{"title":"Alex / Sam: Sync","start":"${date}T10:00:00-05:00","passive":false,"url":"https://example.fellow.app/meetings/x/","contributions":[{"kind":"proposal","what":"Proposed a workaround for the template-variable bug","outcome":"PR to be reviewed Monday"}]}]}`]
      : []),
  ];

  return {
    kind: "worklog-meetings",
    prompt: `You are a read-only data fetcher for a personal work log. Use ONLY ${toolList.join(" and ")}. Never create, edit, accept, decline or delete anything.

${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}

${CAPTURE_RULES}

Reply format:
\`\`\`json
{${sections.join(",\n ")}}
\`\`\``,
    validate: (data) => validateMeetingsReply(data, date, opts),
  };
}

export function validateMeetingsReply(data: unknown, date: string, opts: MeetingsOptions): MeetingsCapture {
  if (!isRec(data)) throw new Error("meetings reply is not an object");
  const calendarCoverage = coverageOf(data.calendar, "calendar");
  const bounds = dayBounds(date, opts.timeZone);

  const meetings: Array<Omit<WorkMeeting, "id">> = [];
  if (calendarCoverage.status !== "failed") {
    const calendar = data.calendar as Record<string, unknown>;
    if (!Array.isArray(calendar.events)) throw new Error("calendar.events array missing");
    for (const row of calendar.events) {
      if (!isRec(row)) throw new Error("calendar event is not an object");
      const title = optString(row.title);
      if (title === null) throw new Error("calendar event is missing a title");
      const start = typeof row.start === "string" ? Date.parse(row.start) : Number.NaN;
      const end = typeof row.end === "string" ? Date.parse(row.end) : Number.NaN;
      if (Number.isNaN(start) || Number.isNaN(end)) throw new Error(`invalid start/end for event "${title}"`);
      if (end <= start) throw new Error(`event "${title}" does not end after it starts`);
      // Defence in depth: the worker was told to skip these, a slip must not count as attended time.
      const responseText = typeof row.response === "string" ? row.response.trim().toLowerCase() : "";
      if (responseText === "declined" || responseText === "no" || row.status === "cancelled") continue;
      if (end - start >= 23 * 3_600_000) continue;
      if (end <= bounds.start.getTime() || start >= bounds.end.getTime()) continue;
      const response = RESPONSES.find((r) => r === row.response) ?? "unknown";
      const attendees = typeof row.attendees === "number" && Number.isFinite(row.attendees) && row.attendees >= 0 ? Math.floor(row.attendees) : null;
      meetings.push({
        title,
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        minutes: Math.round((end - start) / 60_000),
        response,
        attendees,
        noted: false,
        passive: null,
      });
    }
    meetings.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    meetings.splice(MAX_MEETINGS);
  }

  const part = (source: NoteSource): NotesPart => {
    if (!opts.noteSources.includes(source)) return { coverage: OFF(), entries: [], notes: [] };
    const section = data[source];
    // An older worker reply may lack the second note section: count it as not read rather than failing the whole capture.
    if (source === "fellow" && !isRec(section)) return { coverage: { status: "failed", note: "fellow not returned" }, entries: [], notes: [] };
    return notesPart(section, source, coverageOf(section, source), date);
  };
  return { calendar: { coverage: calendarCoverage, meetings }, granola: part("granola"), fellow: part("fellow") };
}

function notesPart(section: unknown, source: NoteSource, coverage: Coverage, date: string): NotesPart {
  const entries: RawEntry[] = [];
  const notes: MeetingNote[] = [];
  if (coverage.status !== "failed") {
    const part = section as Record<string, unknown>;
    if (!Array.isArray(part.meetings)) throw new Error(`${source}.meetings array missing`);
    const contributionKinds = kindsFor(source).filter((k) => k !== "passive");
    for (const row of part.meetings) {
      if (!isRec(row)) throw new Error(`${source} meeting is not an object`);
      const title = optString(row.title);
      if (title === null) throw new Error(`${source} meeting is missing a title`);
      const start = typeof row.start === "string" && !Number.isNaN(Date.parse(row.start)) ? new Date(row.start).toISOString() : null;
      const link = httpsLink(row.url);
      const passive = row.passive === true;
      notes.push({ title, start, passive });
      if (passive) {
        entries.push({ date, source, kind: "passive", what: clip(`${title}: attended, no recorded contribution`, MAX_WHAT), link, outcome: null });
        continue;
      }
      const contributions = Array.isArray(row.contributions) ? row.contributions : [];
      for (const c of contributions.slice(0, MAX_CONTRIBUTIONS)) {
        if (!isRec(c)) throw new Error(`${source} contribution in "${title}" is not an object`);
        const kind = contributionKinds.find((k) => k === c.kind);
        if (kind === undefined) throw new Error(`invalid ${source} contribution kind: ${JSON.stringify(c.kind)}`);
        const what = optString(c.what);
        if (what === null) throw new Error(`${source} contribution in "${title}" has no text`);
        const outcome = optString(c.outcome);
        entries.push({
          date,
          source,
          kind,
          what: clip(`${title}: ${what}`, MAX_WHAT),
          link: httpsLink(c.url) ?? link,
          outcome: outcome === null ? null : clip(outcome, MAX_OUTCOME),
        });
      }
    }
  }

  return { coverage, entries, notes };
}
