// The week's shape: one bar split into meeting hours and focus hours (two segments, a 2px surface gap, both labelled),
// the meeting count and the key meetings. The numbers are in text, so the colours never carry the meaning alone.
import type { WeekPlan } from "../../lib/types";
import { dayName, shapeWidths } from "./helpers";

export function WeekShape({ shape }: { shape: NonNullable<WeekPlan["shape"]> }) {
  const w = shapeWidths(shape);
  return (
    <div className="space-y-2">
      <div
        role="img"
        aria-label={`${shape.meetingHours} hours of meetings across ${shape.meetingCount} meetings, ${shape.focusHours} hours of focus time`}
        className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full bg-card"
      >
        {w.meetings > 0 ? <div className="rounded-l-full bg-muted-foreground/70" style={{ width: `${w.meetings}%` }} title={`${shape.meetingHours}h in meetings`} /> : null}
        {w.focus > 0 ? <div className="rounded-r-full bg-primary" style={{ width: `${w.focus}%` }} title={`${shape.focusHours}h of focus time`} /> : null}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-sm bg-muted-foreground/70" aria-hidden />
          Meetings {shape.meetingHours}h ({shape.meetingCount})
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-sm bg-primary" aria-hidden />
          Focus {shape.focusHours}h
        </span>
      </div>
      {shape.keyMeetings.length > 0 ? (
        <ul className="space-y-0.5 text-sm">
          {shape.keyMeetings.map((m, i) => (
            <li key={i} className="flex flex-wrap items-baseline gap-x-2">
              <span className="w-8 text-xs text-muted-foreground">{dayName(m.date)}</span>
              <span>{m.title}</span>
              {m.why ? <span className="text-xs text-muted-foreground">{m.why}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
