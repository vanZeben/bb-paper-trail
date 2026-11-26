import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { RpcContract } from "../../lib/contract";
import { errorText, ErrorNote, Pill, relativeTime, useAsync } from "../common";
import { gapSummary } from "./gaps";
import { nothingConnected, SOURCE_LABEL, SOURCE_ORDER, STATUS_ICON, STATUS_LABEL, STATUS_TONE, statusOf } from "./sourceMeta";

const CHECK_GIVE_UP_MS = 12 * 60_000;

/** Connector status list with a "Check connectors" button and, in Settings, "Fill gaps (N days)". */
export function ConnectorsPanel({ showFillGaps = false }: { showFillGaps?: boolean }) {
  const rpc = useRpc<RpcContract>();
  const data = useAsync(() => rpc.call("connectors.get"), []);
  const grid = useAsync(() => (showFillGaps ? rpc.call("grid.get", { weeks: 36 }) : Promise.resolve(null)), [showFillGaps]);
  const [error, setError] = useState<string | null>(null);
  // The check runs in the background; "checking" ends when a newer check lands (realtime) or after a long wait.
  const [checkingSince, setCheckingSince] = useState<number | null>(null);
  const check = data.data?.check ?? null;

  useEffect(() => {
    if (checkingSince === null) return;
    if (check !== null && Date.parse(check.checkedAt) >= checkingSince - 1000) {
      setCheckingSince(null);
      return;
    }
    const timer = setTimeout(() => {
      setCheckingSince(null);
      setError("The connector check did not finish. Run `bb paper-trail doctor` to see whether a capture thread can start.");
    }, CHECK_GIVE_UP_MS);
    return () => clearTimeout(timer);
  }, [checkingSince, check]);

  const start = async () => {
    setError(null);
    try {
      await rpc.call("connectors.check");
      setCheckingSince(Date.now());
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const gaps = showFillGaps ? gapSummary(grid.data, check) : { days: 0, weeks: 0 };
  const fill = async () => {
    setError(null);
    try {
      await rpc.call("run.start", { kind: "fill_gaps", weeks: gaps.weeks });
    } catch (cause) {
      setError(errorText(cause));
    }
  };
  const host = check === null ? null : data.data?.hosts.find((h) => h.id === check.hostId);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={checkingSince !== null} onClick={() => void start()}>
          <Icon name={checkingSince !== null ? "Loader" : "RefreshCw"} className="size-3.5" />
          {checkingSince !== null ? "Checking…" : "Check connectors"}
        </Button>
        {showFillGaps && gaps.days > 0 ? (
          <span title="Re-captures weeks where a source was off but is now connected. Each day costs several background agent runs.">
            <Button variant="outline" size="sm" onClick={() => void fill()}>
              <Icon name="Layers" className="size-3.5" />
              Fill gaps ({gaps.days} {gaps.days === 1 ? "day" : "days"})
            </Button>
          </span>
        ) : null}
        <span className="text-xs text-muted-foreground">
          {check === null ? "Never checked." : `Checked ${relativeTime(check.checkedAt)} on ${check.hostName || "the capture host"}${host != null && !host.connected ? " (offline now)" : ""}.`}
        </span>
        {data.data?.stale && check !== null ? <Pill tone="bg-amber-500/20 text-amber-800 dark:text-amber-300">stale</Pill> : null}
      </div>
      <ErrorNote message={error ?? data.error} />
      <ul className="divide-y divide-border rounded-lg border border-border">
        {SOURCE_ORDER.map((id) => {
          const state = check?.sources[id];
          const status = statusOf(state);
          return (
            <li key={id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
              <span className="min-w-40 font-medium">{SOURCE_LABEL[id]}</span>
              <Pill tone={STATUS_TONE[status]}>
                <Icon name={STATUS_ICON[status]} className="mr-1 size-3" />
                {STATUS_LABEL[status]}
              </Pill>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {[state?.account, state?.via ? `via ${state.via}` : null, id === "github" && state?.mode ? (state.mode === "gh" ? "gh CLI" : "GitHub MCP") : null, state?.note].filter(Boolean).join(" · ")}
              </span>
            </li>
          );
        })}
      </ul>
      {nothingConnected(check) ? (
        <p role="alert" className="text-sm text-destructive">
          No source is reachable. Paper Trail needs at least one connected source to rate anything. Connect one on the capture host, then check again.
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Paper Trail holds no credentials: a background agent on the capture host reads your connectors. Sources that are missing show as off on the graph and never lower a rating.
      </p>
    </div>
  );
}
