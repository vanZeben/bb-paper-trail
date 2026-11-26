// Targets editor: one slider and number per framework area, totalling 100. Saves through targets.set.
import { useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { RpcContract } from "../../lib/contract";
import { ErrorNote, errorText, Pill, useAsync } from "../common";
import { evenTargets, slotColor, targetsValid, totalOf, TIME_CSS } from "./helpers";

export function TargetsEditor({ onSaved }: { onSaved?: () => void }) {
  const rpc = useRpc<RpcContract>();
  const framework = useAsync(() => rpc.call("framework.get"), []);
  const stored = useAsync(() => rpc.call("targets.get"), []);
  const [values, setValues] = useState<Record<string, number> | null>(null);
  const [windowWeeks, setWindowWeeks] = useState(4);
  const [watch, setWatch] = useState(10);
  const [off, setOff] = useState(20);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const areas = framework.data?.framework.areas ?? [];
  const keysSig = areas.map((a) => a.key).join(",");
  const loaded = framework.data !== null && !stored.loading;
  useEffect(() => {
    if (!loaded) return;
    const keys = areas.map((a) => a.key);
    const t = stored.data;
    const even = evenTargets(keys);
    setValues((prev) => prev ?? Object.fromEntries(keys.map((k) => [k, t ? (t.targets[k] ?? 0) : (even[k] ?? 0)])));
    if (t) {
      setWindowWeeks(t.windowWeeks);
      setWatch(t.thresholds.watch);
      setOff(t.thresholds.off);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, keysSig, stored.data === null]);

  const total = useMemo(() => (values ? totalOf(values) : 0), [values]);
  const remaining = Math.round((100 - total) * 10) / 10;
  if (!framework.data || values === null) return <p className="text-sm text-muted-foreground">{framework.error ?? "Loading…"}</p>;
  const valid = targetsValid(values) && watch > 0 && off >= watch;

  const set = (key: string, raw: number) => {
    const n = Number.isFinite(raw) ? Math.min(100, Math.max(0, Math.round(raw))) : 0;
    setSaved(false);
    setValues({ ...values, [key]: n });
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await rpc.call("targets.set", {
        targets: { version: 1, frameworkId: framework.data!.framework.id, targets: values, windowWeeks, thresholds: { watch, off }, updatedAt: new Date().toISOString() },
      });
      setSaved(true);
      stored.reload();
      onSaved?.();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rc-time space-y-3">
      <style>{TIME_CSS}</style>
      <p className="text-xs text-muted-foreground">Where do you want your time to go? Targets are percentages of your rated days and must total 100.</p>
      <ul className="space-y-2">
        {areas.map((a, i) => (
          <li key={a.key} className="grid grid-cols-[minmax(0,10rem)_1fr_4.5rem] items-center gap-3">
            <label htmlFor={`target-${a.key}`} className="flex min-w-0 items-center gap-2 text-sm">
              <span className="size-3 shrink-0 rounded-sm" style={{ backgroundColor: slotColor(i) }} aria-hidden />
              <span className="truncate" title={a.description}>{a.label}</span>
            </label>
            <input type="range" min={0} max={100} step={1} value={values[a.key] ?? 0} aria-label={`${a.label} target`} onChange={(e) => set(a.key, Number(e.target.value))} className="w-full" />
            <div className="flex items-center gap-1">
              <input
                id={`target-${a.key}`}
                type="number"
                min={0}
                max={100}
                value={values[a.key] ?? 0}
                onChange={(e) => set(a.key, Number(e.target.value))}
                className="h-8 w-14 rounded-md border border-border bg-background px-2 text-right text-sm tabular-nums"
              />
              <span className="text-xs text-muted-foreground">%</span>
            </div>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        <Pill tone={targetsValid(values) ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-amber-500/15 text-amber-700 dark:text-amber-300"}>
          Total {total}%
        </Pill>
        <span className={cn("text-xs", targetsValid(values) ? "text-muted-foreground" : "text-foreground")}>
          {remaining === 0 ? "Fully allocated" : remaining > 0 ? `${remaining}% left to allocate` : `${-remaining}% over`}
        </span>
      </div>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">Window and thresholds</summary>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5">
            Average over
            <input type="number" min={1} max={12} value={windowWeeks} onChange={(e) => setWindowWeeks(Math.min(12, Math.max(1, Math.round(Number(e.target.value)) || 1)))} className="h-7 w-14 rounded-md border border-border bg-background px-2 text-right tabular-nums" />
            weeks
          </label>
          <label className="flex items-center gap-1.5">
            Watch at
            <input type="number" min={1} max={100} value={watch} onChange={(e) => setWatch(Number(e.target.value))} className="h-7 w-14 rounded-md border border-border bg-background px-2 text-right tabular-nums" />
            points
          </label>
          <label className="flex items-center gap-1.5">
            Off target at
            <input type="number" min={1} max={100} value={off} onChange={(e) => setOff(Number(e.target.value))} className="h-7 w-14 rounded-md border border-border bg-background px-2 text-right tabular-nums" />
            points
          </label>
        </div>
      </details>
      <ErrorNote message={error} />
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!valid || busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save targets"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setValues(evenTargets(areas.map((a) => a.key)))}>
          Even split
        </Button>
        {saved ? <span role="status" className="text-xs text-muted-foreground">Saved</span> : null}
      </div>
    </div>
  );
}
