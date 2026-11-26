// Goals for this half: list and edit through goals.get / goals.set. Goals the agent wrote show where they came from;
// editing the text makes a goal yours. Under each goal are its tasks: edit the text or status, add your own, drop one.
// Dropping a task the agent wrote only marks it dropped, so a refresh does not bring it back; your own tasks are removed.
import { useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { RpcContract } from "../../lib/contract";
import type { Goal, GoalTask } from "../../lib/types";
import { errorText, ErrorNote, Pill, useAsync } from "../common";

const MAX_GOALS = 8;
const MAX_TASKS = 8;
const TASK_STATUS: ReadonlyArray<{ value: GoalTask["status"]; label: string }> = [
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "done", label: "Done" },
  { value: "dropped", label: "Dropped" },
];
const SOURCE_LABEL: Record<GoalTask["source"], string> = { backlog: "backlog", agent: "suggested", user: "yours" };
const newTaskId = () => `u-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const FIELD = "h-8 min-w-0 rounded-md border border-input bg-transparent px-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function GoalsPanel() {
  const rpc = useRpc<RpcContract>();
  const goals = useAsync(() => rpc.call("goals.get"), []);
  const framework = useAsync(() => rpc.call("framework.get"), []);
  const [draft, setDraft] = useState<Goal[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const server = goals.data?.goals ?? null;
  const sig = useMemo(() => JSON.stringify(server), [server]);
  const areas = framework.data?.framework.areas ?? [];

  useEffect(() => {
    if (!dirty && server !== null) setDraft(server.map((g) => ({ ...g, area: g.area ?? null, basis: g.basis ?? null })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  const patch = (i: number, change: Partial<Goal>) => {
    setDirty(true);
    setSaved(false);
    setDraft((d) => (d === null ? d : d.map((g, at) => (at === i ? { ...g, ...change } : g))));
  };
  const patchTasks = (i: number, change: (tasks: GoalTask[]) => GoalTask[]) => {
    setDirty(true);
    setSaved(false);
    setDraft((d) => (d === null ? d : d.map((g, at) => (at === i ? { ...g, tasks: change(g.tasks ?? []) } : g))));
  };
  const patchTask = (i: number, id: string, change: Partial<GoalTask>) => patchTasks(i, (tasks) => tasks.map((t) => (t.id === id ? { ...t, ...change } : t)));
  const dropTask = (i: number, t: GoalTask) =>
    t.source === "user" ? patchTasks(i, (tasks) => tasks.filter((x) => x.id !== t.id)) : patchTask(i, t.id, { status: t.status === "dropped" ? "open" : "dropped" });
  const addTask = (i: number) => patchTasks(i, (tasks) => [...tasks, { id: newTaskId(), text: "", ref: null, source: "user", status: "open", updatedWeek: null, evidenceIds: [] }]);
  const save = async () => {
    if (draft === null) return;
    setError(null);
    setSaving(true);
    try {
      const out = await rpc.call("goals.set", { goals: draft.filter((g) => g.text.trim() !== "") });
      setDraft(out.goals);
      setDirty(false);
      setSaved(true);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  if (draft === null) return <p className="text-sm text-muted-foreground">{goals.error ?? "Loading goals…"}</p>;
  return (
    <div className="space-y-2">
      {draft.length === 0 ? <p className="text-sm text-muted-foreground">No goals yet. Add one, or re-run setup to have the agent draft them from your role card.</p> : null}
      <ul className="space-y-2">
        {draft.map((g, i) => (
          <li key={g.id || i} className="space-y-1 rounded-lg border border-border p-2">
            <div className="flex flex-wrap items-center gap-2">
              <input value={g.text} onChange={(e) => patch(i, { text: e.target.value, source: "user", basis: null })} aria-label={`Goal ${i + 1}`} className={`${FIELD} flex-1 basis-64`} placeholder="What do you want to have done?" />
              <select value={g.area ?? ""} onChange={(e) => patch(i, { area: e.target.value === "" ? null : e.target.value })} aria-label="Area" className={`${FIELD} max-w-44`}>
                <option value="">No area</option>
                {areas.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
              </select>
              <Button variant="ghost" size="sm" aria-label="Remove goal" onClick={() => { setDirty(true); setSaved(false); setDraft(draft.filter((_, at) => at !== i)); }}>
                <Icon name="X" className="size-3.5" />
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <Pill>{g.source === "user" ? "yours" : "set by your agent"}</Pill>
              {g.basis ? <span>Basis: {g.basis}</span> : null}
            </div>
            <ul className="space-y-1 pl-1" aria-label={`Tasks for goal ${i + 1}`}>
              {(g.tasks ?? []).map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-2">
                  <input
                    value={t.text}
                    maxLength={200}
                    onChange={(e) => patchTask(i, t.id, { text: e.target.value })}
                    aria-label="Task"
                    className={`${FIELD} flex-1 basis-56 ${t.status === "dropped" ? "text-muted-foreground line-through" : ""}`}
                    placeholder="A concrete next step"
                  />
                  <select value={t.status} onChange={(e) => patchTask(i, t.id, { status: e.target.value as GoalTask["status"] })} aria-label="Task status" className={`${FIELD} max-w-32`}>
                    {TASK_STATUS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <Pill>{SOURCE_LABEL[t.source]}</Pill>
                  <Button variant="ghost" size="sm" aria-label={t.source !== "user" && t.status === "dropped" ? "Restore task" : "Drop task"} onClick={() => dropTask(i, t)}>
                    <Icon name={t.source !== "user" && t.status === "dropped" ? "RotateCcw" : "X"} className="size-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
            <Button variant="ghost" size="sm" disabled={(g.tasks ?? []).length >= MAX_TASKS} onClick={() => addTask(i)}>
              <Icon name="Plus" className="size-3.5" />Add task
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={draft.length >= MAX_GOALS} onClick={() => { setDirty(true); setSaved(false); setDraft([...draft, { id: "", text: "", area: null, source: "user", basis: null, createdAt: "", tasks: [], droppedRefs: [] }]); }}>
          <Icon name="Plus" className="size-3.5" />Add goal
        </Button>
        <Button size="sm" disabled={saving || !dirty} onClick={() => void save()}>
          <Icon name={saving ? "Loader" : "Check"} className="size-3.5" />Save goals
        </Button>
        {saved ? <span className="text-xs text-muted-foreground">Saved.</span> : null}
      </div>
      <ErrorNote message={error ?? goals.error} />
    </div>
  );
}
