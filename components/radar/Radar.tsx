import { useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { RpcContract } from "../../lib/contract";
import type { GhostCluster } from "../../lib/types";
import { Card, Empty, errorText, ErrorNote, Pill, useAsync } from "../common";
import { clusterHeadline, SURFACED_WHY } from "./labels";
import { safeHref } from "../safeHref";

const SHOWN = 5;

function ClusterCard({ cluster, busy, onClaim, onRaise, onDismiss }: { cluster: GhostCluster; busy: boolean; onClaim: () => void; onRaise: () => void; onDismiss: () => void }) {
  const [all, setAll] = useState(false);
  const items = all ? cluster.items : cluster.items.slice(0, SHOWN);
  return (
    <section className="min-w-0 rounded-lg border border-border bg-card p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{clusterHeadline(cluster)}</p>
          <p className="text-xs text-muted-foreground">{SURFACED_WHY.toLowerCase()}</p>
        </div>
        <Pill>{cluster.weeks[0]}{cluster.weeks.length > 1 ? ` to ${cluster.weeks[cluster.weeks.length - 1]}` : ""}</Pill>
      </div>
      <ul className="mt-2 space-y-1 text-sm">
        {items.map((i) => (
          <li key={`${i.date}|${i.id}`} className="flex items-start gap-2">
            <span className="mt-0.5 shrink-0 rounded bg-muted px-1.5 font-mono text-[11px] text-muted-foreground">{i.id}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground" title={i.what}>
              {i.date.slice(5)} · {i.what}
            </span>
            {safeHref(i.link) === undefined ? null : (
              <a href={safeHref(i.link)} target="_blank" rel="noreferrer" aria-label={`Open ${i.id}`} className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground">
                <Icon name="ExternalLink" className="size-3.5" />
              </a>
            )}
          </li>
        ))}
      </ul>
      {cluster.items.length > SHOWN ? (
        <button type="button" className="mt-1 text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${cluster.items.length}`}
        </button>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={onClaim}>
          Claim for my review
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onRaise}>
          Raise with manager
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </section>
  );
}

/** Invisible work: evidence that no weekly summary, scorecard row, rating or plan result mentions. */
export function Radar(_props: {}) {
  const rpc = useRpc<RpcContract>();
  const list = useAsync(() => rpc.call("ghost.list", { weeks: 8 }), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clusters = list.data?.clusters ?? [];
  const open = clusters.filter((c) => c.state === "new");
  const claimed = clusters.filter((c) => c.state === "claimed").length;

  const act = async (id: string, run: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try {
      await run();
      list.reload();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title="Invisible work" aside="Work that is in your record but that no weekly summary, scorecard row, rating or plan result mentions. Claimed items go into your review packet.">
      <ErrorNote message={error ?? list.error} />
      {list.loading && list.data === null ? (
        <p className="text-sm text-muted-foreground">Looking for unmentioned work…</p>
      ) : open.length === 0 ? (
        <Empty>Nothing unmentioned right now.{claimed > 0 ? ` ${claimed} already claimed.` : ""}</Empty>
      ) : (
        <div className="space-y-3">
          {open.map((c) => (
            <ClusterCard
              key={c.id}
              cluster={c}
              busy={busy === c.id}
              onClaim={() => act(c.id, () => rpc.call("ghost.claim", { id: c.id, as: "note", week: c.weeks[c.weeks.length - 1]!, text: c.label }))}
              onRaise={() => act(c.id, () => rpc.call("ghost.claim", { id: c.id, as: "raise", week: c.weeks[c.weeks.length - 1]!, text: c.label }))}
              onDismiss={() => act(c.id, () => rpc.call("ghost.dismiss", { id: c.id }))}
            />
          ))}
          {claimed > 0 ? <p className="text-xs text-muted-foreground">{claimed} already claimed.</p> : null}
        </div>
      )}
    </Card>
  );
}
