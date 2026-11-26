// Advanced: manual capture controls (they used to sit under the graph). The agent captures on its schedule; these are
// for re-running a week, backfilling or filling gaps by hand.
import { useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { RpcContract } from "../../lib/contract";
import { ErrorNote, Pill, useAsync } from "../common";
import { isBusyKey, isWeekKey, runningLine } from "../graph/helpers";
import { useRun } from "../graph/useRun";
import { gapSummary } from "./gaps";

export function AdvancedPanel() {
  const rpc = useRpc<RpcContract>();
  const grid = useAsync(() => rpc.call("grid.get", { weeks: 36 }), []);
  const conn = useAsync(() => rpc.call("connectors.get"), []);
  const status = useAsync(() => rpc.call("run.status"), []);
  const [error, setError] = useState<string | null>(null);
  const run = useRun(setError);
  const [week, setWeek] = useState<string | null>(null);
  const current = week ?? grid.data?.currentWeek ?? "";
  const s = status.data ?? grid.data?.status ?? null;
  const valid = isWeekKey(current);
  const weekBusy = s !== null && isBusyKey(s, `week:${current.trim()}`);
  const gaps = gapSummary(grid.data, conn.data?.check ?? null);
  const line = s ? runningLine(s) : null;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={current}
          onChange={(event) => setWeek(event.target.value)}
          placeholder="YYYY-Www"
          aria-label="Week to run"
          className={cn("h-8 w-28 rounded-md border bg-background px-2 font-mono text-xs", valid ? "border-border" : "border-destructive/60")}
        />
        <Button variant="outline" size="sm" disabled={!valid || weekBusy} onClick={() => void run({ kind: "week", week: current.trim(), recapture: false })}>
          <Icon name={weekBusy ? "Loader" : "Play"} className="size-3.5" />Run week…
        </Button>
        <Button variant="outline" size="sm" disabled={s !== null && isBusyKey(s, "backfill")} onClick={() => void run({ kind: "backfill", weeks: 4, force: false })}>
          <Icon name="Layers" className="size-3.5" />Backfill 4 weeks
        </Button>
        {gaps.days > 0 ? (
          <span title="Re-captures weeks where a source was off but is now connected. Each day costs several background agent runs.">
            <Button variant="outline" size="sm" onClick={() => void run({ kind: "fill_gaps", weeks: gaps.weeks })}>
              <Icon name="Layers" className="size-3.5" />Fill gaps ({gaps.days} {gaps.days === 1 ? "day" : "days"})
            </Button>
          </span>
        ) : null}
        {line ? (
          <Pill tone="bg-blue-500/15 text-blue-700 dark:text-blue-300">
            <Icon name="Loader" className="mr-1 size-3" />running {line}
          </Pill>
        ) : null}
        {s && s.queued.length > 0 ? <span className="text-xs text-muted-foreground">{s.queued.length} queued</span> : null}
      </div>
      {s?.lastError ? <ErrorNote message={`Last run failed (${s.lastError.key}): ${s.lastError.message}`} /> : null}
      <ErrorNote message={error} />
      <p className="text-xs text-muted-foreground">Models, the capture host and the schedule times live in bb's plugin settings for this plugin.</p>
    </div>
  );
}
