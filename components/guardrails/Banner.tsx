import { useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { RpcContract } from "../../lib/contract";
import type { GuardrailResult } from "../../lib/types";
import { errorText, ErrorNote, Pill, useAsync } from "../common";
import { currentResults, SEVERITY_META, weekSpan } from "./helpers";
import { safeHref } from "../safeHref";

function Row({ result, onDone }: { result: GuardrailResult; onDone: () => void }) {
  const rpc = useRpc<RpcContract>();
  const meta = SEVERITY_META[result.severity];
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const acknowledge = async () => {
    setBusy(true);
    setError(null);
    try {
      await rpc.call("guardrails.ack", { id: result.id, note: note.trim() });
      onDone();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={cn("rounded-lg border bg-card p-3", meta.border)}>
      <div className="flex flex-wrap items-start gap-2">
        <Icon name={meta.icon} className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{result.title}</p>
          {result.detail !== "" ? <p className="mt-0.5 text-xs text-muted-foreground">{result.detail}</p> : null}
        </div>
        <Pill tone={meta.tone}>{meta.label}</Pill>
        <span title={`First breached ${result.firstBreachedWeek}`}><Pill>{weekSpan(result)}</Pill></span>
      </div>
      {result.evidence.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Evidence</span>
          {result.evidence.map((e) =>
            e.link === null ? (
              <span key={`${e.date}|${e.id}`} title={e.date} className="rounded bg-muted px-1.5 font-mono text-[11px] text-muted-foreground">{e.id}</span>
            ) : (
              <a key={`${e.date}|${e.id}`} href={safeHref(e.link)} target="_blank" rel="noreferrer" title={`${e.date}: open source`} className="rounded bg-muted px-1.5 font-mono text-[11px] text-foreground hover:underline">
                {e.id}
              </a>
            ),
          )}
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {asking ? (
          <>
            <Input aria-label="Acknowledgement note (optional)" placeholder="Note (optional)" maxLength={300} className="h-8 min-w-0 max-w-sm flex-1" value={note} onChange={(e) => setNote(e.target.value)} />
            <Button size="sm" disabled={busy} onClick={() => void acknowledge()}>
              <Icon name={busy ? "Loader" : "Check"} className="size-3.5" />Acknowledge
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setAsking(false); setNote(""); }}>Cancel</Button>
          </>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setAsking(true)}>Acknowledge</Button>
        )}
      </div>
      <ErrorNote message={error} />
    </li>
  );
}

/** Open guardrail results above the graph: worst first, the newest per rule. Renders nothing when everything is clear. */
export function GuardrailBanner(_props: {}) {
  const rpc = useRpc<RpcContract>();
  const results = useAsync(() => rpc.call("guardrails.results", { weeks: 12, state: "open" }), []);
  const open = currentResults(results.data?.results ?? []);
  if (open.length === 0) return results.error === null ? null : <ErrorNote message={results.error} />;
  return (
    <section aria-label="Guardrails" className="space-y-2">
      <ul className="space-y-2">
        {open.map((r) => (
          <Row key={r.id} result={r} onDone={results.reload} />
        ))}
      </ul>
    </section>
  );
}
