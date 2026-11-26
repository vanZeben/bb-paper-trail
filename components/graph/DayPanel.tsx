import type { ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { RpcContract } from "../../lib/contract";
import type { OverrideTarget, WorklogStatus } from "../../lib/types";
import { Card, Empty, ErrorNote, Pill, useAsync } from "../common";
import { OverrideContext } from "./overrideContext";
import { formatHours, formatPct, formatTime, highlights, isBusyKey, meetingPctOfDay, RATING_LABEL, weekdayLabel } from "./helpers";
import { CoverageLine, EvidenceRow, RatingPill } from "./parts";
import { useRun } from "./useRun";

export interface DayPanelProps {
  date: string;
  status: WorklogStatus;
  /** IANA zone and working-day length, both from the `grid.get` payload. */
  timeZone: string;
  workdayHours: number;
  onClose: () => void;
  onError: (message: string | null) => void;
  /** Slot for the confirm/override control. Rendered with the day's override target. */
  renderOverride?: (target: OverrideTarget) => ReactNode;
}

export function DayPanel({ date, status, timeZone, workdayHours, onClose, onError, renderOverride }: DayPanelProps) {
  const rpc = useRpc<RpcContract>();
  const day = useAsync(() => rpc.call("day.get", { date }), [date]);
  const run = useRun(onError);
  const data = day.data?.day ?? null;
  const busy = isBusyKey(status, `day:${date}`);
  const minutes = data?.meetingMinutes ?? 0;
  const effective = day.data?.effectiveRating ?? data?.rating?.rating ?? null;
  const override = day.data?.override ?? null;
  return (
    <Card title={weekdayLabel(date)}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {effective !== null ? <RatingPill rating={effective} provisional={data?.rating?.provisional && override === null} /> : <Pill>{day.loading ? "loading" : "no rating"}</Pill>}
          {override?.decision === "overridden" ? <Pill>overridden · AI said {RATING_LABEL[data?.rating?.rating ?? "none"]}</Pill> : null}
          {override?.decision === "confirmed" ? <Pill>confirmed</Pill> : null}
          {data?.rating?.stale ? <Pill tone="bg-amber-500/15 text-amber-700 dark:text-amber-300">rating out of date</Pill> : null}
          <span className="flex-1" />
          {day.data && !day.data.weekFinal ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void run({ kind: "day", date })}>
              <Icon name={busy ? "Loader" : "RefreshCw"} className="size-3.5" />
              Re-capture day
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" aria-label="Close" onClick={onClose}>
            <Icon name="X" className="size-3.5" />
          </Button>
        </div>
        <ErrorNote message={day.error} />
        {data === null && !day.loading && !day.error ? <Empty>No capture for this day yet.</Empty> : null}
        {data ? (
          <>
            {data.rating ? (
              <div className="space-y-1 text-sm">
                <p>{data.rating.summary}</p>
                <p className="text-muted-foreground">{data.rating.reason}</p>
              </div>
            ) : null}
            {renderOverride ? (
              <OverrideContext.Provider value={() => ({ ai: data.rating?.rating ?? null, override })}>{renderOverride({ type: "day", date })}</OverrideContext.Provider>
            ) : null}
            <CoverageLine coverage={data.coverage} />
            <div>
              <h4 className="mb-1 text-xs font-semibold text-muted-foreground">
                Meetings · {data.meetingCount} · {formatHours(minutes / 60)} ({formatPct(meetingPctOfDay(minutes, workdayHours))} of day)
              </h4>
              <ul className="space-y-0.5 text-sm">
                {data.meetings.map((m) => (
                  <li key={m.id} className="flex items-center gap-2">
                    <span className="w-28 shrink-0 text-xs tabular-nums text-muted-foreground">
                      {formatTime(m.start, timeZone)}–{formatTime(m.end, timeZone)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{m.title}</span>
                    <span className="text-xs text-muted-foreground">{m.minutes}m</span>
                    {m.passive ? <Pill>passive</Pill> : null}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h4 className="mb-1 text-xs font-semibold text-muted-foreground">Evidence highlights</h4>
              {highlights(data).length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing notable captured.</p>
              ) : (
                <ul className="space-y-1.5">
                  {highlights(data).map((e) => (
                    <EvidenceRow key={e.id} entry={e} />
                  ))}
                </ul>
              )}
            </div>
          </>
        ) : null}
      </div>
    </Card>
  );
}
