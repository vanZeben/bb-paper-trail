// The plan editor: add, change, remove and carry over a week's intentions. Mounted from the Plan tab's Edit toggle and
// from Settings. The agent plans the week on its own; this is only for changing its mind.
import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { RpcContract } from "../../lib/contract";
import { previousWeeks } from "../../lib/engine/dates";
import { carryOverCandidates, MAX_ITEMS } from "../../lib/features/plan/logic";
import { Empty, errorText, ErrorNote, useAsync } from "../common";

interface Draft {
  id?: string;
  text: string;
  area: string | null;
}

export function PlanEditor({ week: weekProp, onSaved }: { week?: string; onSaved?: () => void }) {
  const rpc = useRpc<RpcContract>();
  const grid = useAsync(() => rpc.call("grid.get", { weeks: 4 }), []);
  const week = weekProp ?? grid.data?.currentWeek ?? null;
  const prevWeek = week === null ? null : previousWeeks(week, 1)[0]!;
  const plan = useAsync(() => (week === null ? Promise.resolve(null) : rpc.call("plan.get", { week })), [week]);
  const prev = useAsync(() => (prevWeek === null ? Promise.resolve(null) : rpc.call("plan.get", { week: prevWeek })), [prevWeek]);
  const [draft, setDraft] = useState<Draft[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const stored = plan.data;
  useEffect(() => {
    if (stored) setDraft(stored.items.map((i) => ({ id: i.id, text: i.text, area: i.area })));
  }, [stored]);

  if (!week || !stored || !draft) return <Empty>{grid.error ?? plan.error ?? "Loading the plan…"}</Empty>;
  const areas = grid.data?.areas ?? [];
  const dirty = JSON.stringify(draft) !== JSON.stringify(stored.items.map((i) => ({ id: i.id, text: i.text, area: i.area })));
  const used = new Set(draft.flatMap((d) => (d.id ? [d.id] : [])));
  const carry = carryOverCandidates(prev.data ?? null).filter((c) => !used.has(c.fromId));

  const update = (n: number, patch: Partial<Draft>) => setDraft(draft.map((d, i) => (i === n ? { ...d, ...patch } : d)));
  const save = async () => {
    setSaving(true);
    try {
      setError(null);
      const items = draft.filter((d) => d.text.trim() !== "").map((d) => ({ ...(d.id ? { id: d.id } : {}), text: d.text.trim(), area: d.area }));
      await rpc.call("plan.set", { week, items });
      plan.reload();
      onSaved?.();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <ErrorNote message={error} />
      {draft.map((d, n) => (
        <div key={d.id ?? `new-${n}`} className="flex items-center gap-2">
          <input
            value={d.text}
            maxLength={200}
            onChange={(event) => update(n, { text: event.target.value })}
            aria-label={`Intention ${n + 1}`}
            placeholder="What do you intend to get done?"
            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm"
          />
          <select
            value={d.area ?? ""}
            onChange={(event) => update(n, { area: event.target.value === "" ? null : event.target.value })}
            aria-label={`Area for intention ${n + 1}`}
            className="h-8 w-40 rounded-md border border-border bg-background px-1.5 text-xs"
          >
            <option value="">No area</option>
            {areas.map((a) => (
              <option key={a.key} value={a.key}>
                {a.label}
              </option>
            ))}
          </select>
          <Button variant="ghost" size="icon" aria-label={`Remove intention ${n + 1}`} onClick={() => setDraft(draft.filter((_, i) => i !== n))}>
            <Icon name="X" className="size-4" />
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button variant="outline" size="sm" disabled={draft.length >= MAX_ITEMS} onClick={() => setDraft([...draft, { text: "", area: null }])}>
          <Icon name="Plus" className="size-3.5" />
          Add intention
        </Button>
        <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
          Save
        </Button>
        <span className="text-xs text-muted-foreground">{draft.length} of {MAX_ITEMS}</span>
      </div>
      {carry.length > 0 ? (
        <div className="mt-3 border-t border-border pt-3">
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">Unfinished last week. Click to carry over.</p>
          <div className="flex flex-wrap gap-1.5">
            {carry.map((c) => (
              <button
                key={c.fromId}
                type="button"
                disabled={draft.length >= MAX_ITEMS}
                onClick={() => setDraft([...draft, { id: c.fromId, text: c.text, area: c.area }])}
                className="inline-flex max-w-full items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs hover:bg-muted/50 disabled:opacity-50"
              >
                <Icon name="CornerDownRight" className="size-3 shrink-0" />
                <span className="truncate">{c.text}</span>
                <span className="shrink-0 text-muted-foreground">({c.carryCount}×)</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
