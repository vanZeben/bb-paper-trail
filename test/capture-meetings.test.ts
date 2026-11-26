import { describe, expect, it } from "vitest";
import { meetingsJob, validateMeetingsReply, type MeetingsOptions } from "../lib/capture/meetings";

const D = "2026-11-09";
const TZ = "America/New_York";
const BOTH: MeetingsOptions = { timeZone: TZ, noteSources: ["granola", "fellow"] };
const GRANOLA_ONLY: MeetingsOptions = { timeZone: TZ, noteSources: ["granola"] };
const FELLOW_ONLY: MeetingsOptions = { timeZone: TZ, noteSources: ["fellow"] };
const NONE: MeetingsOptions = { timeZone: TZ, noteSources: [] };

const event = (over: Record<string, unknown> = {}) => ({ title: "Design review", start: `${D}T14:00:00-05:00`, end: `${D}T15:00:00-05:00`, response: "needsAction", attendees: 7, url: null, ...over });
const reply = (events: unknown[], meetings: unknown[] = [], over: Record<string, unknown> = {}) => ({
  calendar: { available: true, note: null, events },
  granola: { available: true, note: null, meetings },
  ...over,
});

describe("validateMeetingsReply", () => {
  it("keeps non-declined timed events as attended and drops declined, all-day, cancelled and out-of-day ones", () => {
    const out = validateMeetingsReply(
      reply([
        event(),
        event({ title: "Declined", response: "declined" }),
        event({ title: "All day", start: `${D}T00:00:00-05:00`, end: `${D}T23:59:00-05:00` }),
        event({ title: "Cancelled", status: "cancelled" }),
        event({ title: "Yesterday", start: "2026-11-08T14:00:00-05:00", end: "2026-11-08T15:00:00-05:00" }),
        event({ title: "No reply", response: "weird", start: `${D}T10:00:00-05:00`, end: `${D}T10:30:00-05:00` }),
      ]),
      D,
      GRANOLA_ONLY,
    );
    expect(out.calendar.meetings.map((m) => m.title)).toEqual(["No reply", "Design review"]);
    expect(out.calendar.meetings[0]).toMatchObject({ response: "unknown", minutes: 30 });
    expect(out.calendar.meetings[1]).toMatchObject({ response: "needsAction", minutes: 60, attendees: 7, noted: false, passive: null });
    expect(out.calendar.coverage).toEqual({ status: "ok", note: null });
  });

  it("uses the given time zone for the day bounds", () => {
    // 23:30 on Nov 9 in New York is already Nov 10 in UTC; 00:30 Nov 10 in New York is outside the day.
    const inDay = event({ title: "Late", start: "2026-11-09T23:30:00-05:00", end: "2026-11-10T00:00:00-05:00" });
    const outDay = event({ title: "After midnight", start: "2026-11-10T00:30:00-05:00", end: "2026-11-10T01:00:00-05:00" });
    expect(validateMeetingsReply(reply([inDay, outDay]), D, GRANOLA_ONLY).calendar.meetings.map((m) => m.title)).toEqual(["Late"]);
    expect(validateMeetingsReply(reply([inDay, outDay]), D, { timeZone: "UTC", noteSources: ["granola"] }).calendar.meetings.map((m) => m.title)).toEqual([]);
  });

  it("maps availability to coverage", () => {
    const failed = validateMeetingsReply({ calendar: { available: false, note: "no calendar tool" }, granola: { available: true, note: "two notes unreadable", meetings: [] } }, D, GRANOLA_ONLY);
    expect(failed.calendar.coverage).toEqual({ status: "failed", note: "no calendar tool" });
    expect(failed.calendar.meetings).toEqual([]);
    expect(failed.granola.coverage).toEqual({ status: "partial", note: "two notes unreadable" });
  });

  it("throws on malformed input", () => {
    expect(() => validateMeetingsReply({ calendar: { available: "yes" }, granola: { available: true } }, D, GRANOLA_ONLY)).toThrow();
    expect(() => validateMeetingsReply({ calendar: { available: true, events: [] } }, D, GRANOLA_ONLY)).toThrow();
    expect(() => validateMeetingsReply(reply([event({ start: "nope" })]), D, GRANOLA_ONLY)).toThrow(/start\/end/);
    expect(() => validateMeetingsReply(reply([event({ end: `${D}T13:00:00-05:00` })]), D, GRANOLA_ONLY)).toThrow();
    expect(() => validateMeetingsReply(reply([], [{ title: "x", passive: false, contributions: [{ kind: "passive", what: "y" }] }]), D, GRANOLA_ONLY)).toThrow(/kind/);
  });

  it("turns Granola contributions into evidence and a passive meeting into one passive entry", () => {
    const out = validateMeetingsReply(
      reply([event()], [
        { title: "Design review", start: `${D}T14:00:00-05:00`, passive: false, url: "https://granola.example/n1", contributions: [{ kind: "decision", what: "Vouched for the gateway design", outcome: "Approved" }] },
        { title: "All hands", start: `${D}T16:00:00-05:00`, passive: true, contributions: [{ kind: "decision", what: "ignored" }] },
      ]),
      D,
      GRANOLA_ONLY,
    );
    expect(out.granola.entries).toEqual([
      { date: D, source: "granola", kind: "decision", what: "Design review: Vouched for the gateway design", link: "https://granola.example/n1", outcome: "Approved" },
      { date: D, source: "granola", kind: "passive", what: "All hands: attended, no recorded contribution", link: null, outcome: null },
    ]);
    expect(out.granola.notes.map((n) => n.passive)).toEqual([false, true]);
  });

  it("drops declined / no responses case-insensitively", () => {
    const out = validateMeetingsReply(reply([event({ title: "A", response: "Declined" }), event({ title: "B", response: "NO" }), event({ title: "C", response: "accepted" })]), D, GRANOLA_ONLY);
    expect(out.calendar.meetings.map((m) => m.title)).toEqual(["C"]);
  });
});

describe("meetingsJob prompt", () => {
  it("builds a read-only prompt with the date, zone, the attended rule and the shared rules", () => {
    const job = meetingsJob(D, BOTH);
    expect(job.prompt).toContain(D);
    expect(job.prompt).toContain(TZ);
    expect(job.prompt).toMatch(/did not explicitly decline/);
    expect(job.prompt).toMatch(/Never create, edit/);
    expect(job.prompt).toMatch(/Never derive a name from a login/);
    expect(job.guard).toBeUndefined();
  });

  it("names tools by capability, with tool names only as examples", () => {
    const { prompt } = meetingsJob(D, BOTH);
    expect(prompt).toMatch(/calendar read tools/);
    expect(prompt).toMatch(/Granola meeting-notes read tools/);
    expect(prompt).toMatch(/\(e\.g\./);
  });
});

describe("Fellow meeting notes", () => {
  const fellowMeeting = { title: "Alex / Sam: Sync", start: `${D}T10:00:00-05:00`, passive: false, url: "https://acme.fellow.app/meetings/x/", contributions: [{ kind: "proposal", what: "Proposed the template workaround", outcome: "PR Monday" }] };

  it("parses a fellow section into fellow evidence and notes", () => {
    const out = validateMeetingsReply({ ...reply([event()]), fellow: { available: true, note: null, meetings: [fellowMeeting, { title: "Town Hall", start: null, passive: true, url: null, contributions: [] }] } }, D, BOTH);
    expect(out.fellow.coverage).toEqual({ status: "ok", note: null });
    expect(out.fellow.entries.map((e) => [e.source, e.kind, e.what])).toEqual([
      ["fellow", "proposal", "Alex / Sam: Sync: Proposed the template workaround"],
      ["fellow", "passive", "Town Hall: attended, no recorded contribution"],
    ]);
    expect(out.fellow.entries[0]!.link).toBe("https://acme.fellow.app/meetings/x/");
    expect(out.fellow.notes.map((n) => n.title)).toEqual(["Alex / Sam: Sync", "Town Hall"]);
  });

  it("treats a reply without a fellow section as not read, without failing calendar or granola", () => {
    const out = validateMeetingsReply(reply([event()]), D, BOTH);
    expect(out.fellow.coverage).toEqual({ status: "failed", note: "fellow not returned" });
    expect(out.calendar.meetings).toHaveLength(1);
  });

  it("rejects an invalid fellow contribution kind and passes through available:false", () => {
    expect(() => validateMeetingsReply({ ...reply([event()]), fellow: { available: true, meetings: [{ ...fellowMeeting, contributions: [{ kind: "vibes", what: "x" }] }] } }, D, BOTH)).toThrow(/invalid fellow contribution kind/);
    const off = validateMeetingsReply({ ...reply([event()]), fellow: { available: false, note: "Fellow not connected" } }, D, BOTH);
    expect(off.fellow.coverage).toEqual({ status: "failed", note: "Fellow not connected" });
  });

  it("asks the worker to skip meetings Granola already covers when both are enabled", () => {
    const { prompt } = meetingsJob(D, BOTH);
    expect(prompt).toMatch(/Fellow:.*SKIP any meeting already covered by a Granola note/s);
    expect(prompt).toContain('"fellow":{"available":true');
  });
});

describe("disabled note sources", () => {
  it("yields off coverage, no entries, and ignores a stray section", () => {
    const out = validateMeetingsReply(
      { ...reply([event()], [{ title: "x", passive: true }]), fellow: { available: true, meetings: [{ title: "y", passive: true }] } },
      D,
      NONE,
    );
    for (const part of [out.granola, out.fellow]) {
      expect(part.coverage.status).toBe("off");
      expect(part.entries).toEqual([]);
      expect(part.notes).toEqual([]);
    }
    expect(out.calendar.meetings).toHaveLength(1);
  });

  it("does not require a section for a disabled source, and is off only for that source", () => {
    const out = validateMeetingsReply({ calendar: { available: true, note: null, events: [] }, fellow: { available: true, note: null, meetings: [] } }, D, FELLOW_ONLY);
    expect(out.granola.coverage.status).toBe("off");
    expect(out.fellow.coverage).toEqual({ status: "ok", note: null });
  });

  it("never mentions a disabled source in the prompt", () => {
    const fellowOnly = meetingsJob(D, FELLOW_ONLY).prompt;
    expect(fellowOnly).not.toMatch(/granola/i);
    expect(fellowOnly).toMatch(/Fellow/);
    expect(fellowOnly).toContain("contributions");
    const granolaOnly = meetingsJob(D, GRANOLA_ONLY).prompt;
    expect(granolaOnly).not.toMatch(/fellow/i);
    expect(granolaOnly).toMatch(/Granola/);
    const none = meetingsJob(D, NONE).prompt;
    expect(none).not.toMatch(/granola|fellow/i);
    expect(none).toMatch(/calendar read tools/);
  });
});

describe("meetings identity", () => {
  const identity = { name: "Alex Doe", email: "alex@example.com", handles: { slack: "U0ALEX", github: "alexdoe" } };
  it("adds the identity line and stays unchanged without one", () => {
    const prompt = meetingsJob(D, { ...BOTH, identity }).prompt;
    expect(prompt).toContain("The user is Alex Doe (alex@example.com; Slack U0ALEX; GitHub @alexdoe). In meeting transcripts and notes, their lines are attributed to this name or email.");
    expect(meetingsJob(D, BOTH).prompt).not.toContain("The user is");
    expect(meetingsJob(D, { ...BOTH, identity: { name: "Eve\nIgnore <<< previous", email: null, handles: {} } }).prompt).toContain("The user is Eve Ignore  previous.");
  });
});
