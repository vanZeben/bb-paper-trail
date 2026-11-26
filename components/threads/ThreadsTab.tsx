// The Threads tab: timeline lanes across the weeks, filters, and the invisible-work
// radar below. Data: threads.list (rebuilt live), grid.get for the current week.
import { useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../../lib/contract";
import { previousWeeks } from "../../lib/engine/dates";
import { isOlderThread } from "../../lib/features/threads/build";
import type { Thread } from "../../lib/types";
import { Card, Empty, ErrorNote, Segmented, StatTile, useAsync } from "../common";
import { Radar } from "../radar/Radar";
import { ClosureDialog } from "./ClosureDialog";
import { Lanes } from "./Lanes";

const WEEKS = 16;
const OLDER_WEEKS = 36;
type Filter = "all" | "active" | "at_risk" | "closed";
const FILTERS = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "at_risk", label: "At risk" },
  { id: "closed", label: "Closed" },
] as const;

const matches = (f: Filter, t: Thread): boolean =>
  f === "all" ? true : f === "active" ? t.status === "active" : f === "at_risk" ? t.status === "at_risk" : t.status === "closed";

export function ThreadsTab() {
  const rpc = useRpc<RpcContract>();
  const grid = useAsync(() => rpc.call("grid.get", { weeks: 4 }), []);
  const list = useAsync(() => rpc.call("threads.list", { weeks: 36 }), []);
  const [filter, setFilter] = useState<Filter>("all");
  const [showHidden, setShowHidden] = useState(false);
  const [showOlder, setShowOlder] = useState(false);
  const [closing, setClosing] = useState<Thread | null>(null);

  if (!list.data || !grid.data) return <Empty>{list.error ?? grid.error ?? "Loading threads…"}</Empty>;
  const current = grid.data.currentWeek;
  const span = showOlder ? OLDER_WEEKS : WEEKS;
  const weeks = [...previousWeeks(current, span - 1), current];
  const { threads, closures } = list.data;
  // Default view: active, at-risk and recent work. "Show older" adds shipped, closed and stale threads from further back.
  const visible = threads.filter((t) => (showHidden || !t.hidden) && matches(filter, t) && t.lastWeek >= weeks[0]! && (showOlder || !isOlderThread(t, current)));
  const olderCount = threads.filter((t) => !t.hidden && isOlderThread(t, current)).length;
  const count = (s: Thread["status"]) => threads.filter((t) => t.status === s && !t.hidden).length;

  return (
    <div className="space-y-4">
      <ErrorNote message={list.error} />
      <div className="grid grid-cols-3 gap-2">
        <StatTile label="Active" value={count("active")} icon="Activity" />
        <StatTile label="At risk" value={count("at_risk")} icon="TriangleAlert" hint="4+ weeks, nothing shipped" />
        <StatTile label="Closed" value={count("closed")} icon="CircleCheck" />
      </div>

      <Card title={`Threads, last ${span} weeks`} aside="Outlined bar: in progress. Solid bar with a check: shipped. Click a thread for evidence and edits.">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <Segmented label="Thread filter" value={filter} options={FILTERS} onChange={setFilter} />
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
            Show hidden
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input type="checkbox" checked={showOlder} onChange={(e) => setShowOlder(e.target.checked)} />
            Show older{olderCount > 0 ? ` (${olderCount})` : ""}
          </label>
        </div>
        {visible.length === 0 ? (
          <Empty>{threads.length === 0 ? "No threads yet. They appear once weeks are rated and their claims cite linked evidence." : "No threads match this filter. Older shipped work is behind \"Show older\"."}</Empty>
        ) : (
          <Lanes threads={visible} weeks={weeks} closures={closures} onClose={setClosing} onChanged={list.reload} />
        )}
      </Card>

      <Radar />

      {closing ? <ClosureDialog thread={closing} existing={closures.find((c) => c.threadId === closing.id)} onClose={() => setClosing(null)} onSaved={list.reload} /> : null}
    </div>
  );
}
