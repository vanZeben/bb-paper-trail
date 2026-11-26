// The status strip under the graph: when something was last captured and what is running now. The manual run controls
// (Run week, Backfill, Fill gaps) live in Settings > Advanced; the agent captures on its schedule.
import { Icon } from "@/components/ui/icon";
import type { WorklogGrid, WorklogStatus } from "../../lib/types";
import { ErrorNote, Pill } from "../common";
import { captureStatusLine } from "./captureStatus";
import { runningLine } from "./helpers";

export function Controls({ grid, status }: { grid: Pick<WorklogGrid, "weeks" | "today">; status: WorklogStatus }) {
  const line = runningLine(status);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{captureStatusLine(grid.weeks, grid.today)}</span>
        {line ? (
          <Pill tone="bg-blue-500/15 text-blue-700 dark:text-blue-300">
            <Icon name="Loader" className="mr-1 size-3" />
            running {line}
          </Pill>
        ) : null}
        {status.queued.length > 0 ? <span>{status.queued.length} queued</span> : null}
      </div>
      {status.lastError ? <ErrorNote message={`Last run failed (${status.lastError.key}): ${status.lastError.message}`} /> : null}
    </div>
  );
}
