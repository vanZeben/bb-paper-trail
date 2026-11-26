// Goals & tasks (read-only): each goal with its area, basis, progress (tasks done of total, weeks advanced) and its tasks.
// Data: goals.get, framework.get (area labels) and packet.build over the last half year (goal progress is already
// counted per goal there: one call instead of one week.get per week). Edits are in Settings -> Goals.
import { useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import type { RpcContract } from "../../lib/contract";
import { addDays } from "../../lib/engine/dates";
import type { Goal, GoalTask } from "../../lib/types";
import { Empty, ErrorNote, errorText, Pill, relativeTime, SectionTitle, useAsync } from "../common";
import { safeHref } from "../safeHref";

const STATUS: Record<GoalTask["status"], { label: string; icon: string; tone: string }> = {
  done: { label: "Done", icon: "CircleCheck", tone: "bg-green-700/20 text-green-800 dark:text-green-300" },
  in_progress: { label: "In progress", icon: "CircleDot", tone: "bg-sky-600/20 text-sky-800 dark:text-sky-300" },
  open: { label: "Open", icon: "Circle", tone: "bg-muted text-muted-foreground" },
  dropped: { label: "Dropped", icon: "Ban", tone: "bg-muted text-muted-foreground" },
};
const SOURCE: Record<GoalTask["source"], string> = { backlog: "backlog", agent: "suggested", user: "yours" };
/** Half a year of weeks: what "weeks advanced" counts over. */
const PROGRESS_WEEKS = 26;

/** Tasks that count: dropped ones are out of both numbers. */
export const taskCounts = (tasks: readonly GoalTask[]): { done: number; total: number } => {
  const live = tasks.filter((t) => t.status !== "dropped");
  return { done: live.filter((t) => t.status === "done").length, total: live.length };
};

function TaskRow({ task }: { task: GoalTask }) {
  const s = STATUS[task.status];
  const href = safeHref(task.ref);
  return (
    <li className="flex flex-wrap items-center gap-2 text-sm">
      <Pill tone={s.tone}>
        <Icon name={s.icon} className="mr-1 size-3" />
        {s.label}
      </Pill>
      <span className={task.status === "dropped" || task.status === "done" ? "text-muted-foreground" : ""}>{task.text}</span>
      <Pill>{SOURCE[task.source]}</Pill>
      {task.ref === null ? null : href ? (
        <a href={href} target="_blank" rel="noreferrer" className="rounded bg-muted px-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground" title={task.ref}>
          {/^https:/.test(task.ref) ? "link" : task.ref}
        </a>
      ) : (
        <span className="rounded bg-muted px-1.5 font-mono text-[11px] text-muted-foreground">{task.ref}</span>
      )}
    </li>
  );
}

export function GoalsTasks(_props: {}) {
  const rpc = useRpc<RpcContract>();
  const [range] = useState(() => {
    const to = new Date().toISOString().slice(0, 10);
    return { from: addDays(to, -7 * PROGRESS_WEEKS), to };
  });
  const goals = useAsync(() => rpc.call("goals.get"), []);
  const framework = useAsync(() => rpc.call("framework.get"), []);
  const packet = useAsync(() => rpc.call("packet.build", range), [range.from, range.to]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      await rpc.call("goals.refresh");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const list: Goal[] = goals.data?.goals ?? [];
  const labels = new Map((framework.data?.framework.areas ?? []).map((a) => [a.key, a.label]));
  const weeks = new Map((packet.data?.goals ?? []).map((g) => [g.goalId, g]));
  const refreshedAt = goals.data?.tasksRefreshedAt ?? null;
  const anyTasks = list.some((g) => (g.tasks ?? []).length > 0);

  return (
    <section className="min-w-0 space-y-3" aria-label="Goals and tasks">
      <SectionTitle
        aside={
          <button type="button" onClick={() => void refresh()} disabled={busy || list.length === 0} className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50">
            {busy ? "Refreshing…" : "Refresh tasks"}
          </button>
        }
      >
        Goals &amp; tasks
      </SectionTitle>
      {list.length === 0 || (!anyTasks && refreshedAt === null) ? <Empty>Tasks appear after the first scan</Empty> : null}
      <ul className="space-y-3">
        {list.map((g) => {
          const tasks = g.tasks ?? [];
          const { done, total } = taskCounts(tasks);
          const w = weeks.get(g.id);
          const area = g.area === null ? null : (labels.get(g.area) ?? g.area);
          return (
            <li key={g.id} className="space-y-1.5 rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                {area === null ? null : <Pill>{area}</Pill>}
                <span className="text-sm font-medium" title={g.basis ? `Basis: ${g.basis}` : undefined}>
                  {g.text}
                </span>
                {g.basis ? <Icon name="Info" className="size-3.5 text-muted-foreground" aria-label={`Basis: ${g.basis}`} /> : null}
              </div>
              <p className="text-xs text-muted-foreground">
                {total === 0 ? "No tasks yet" : `${done} of ${total} tasks done`}
                {w === undefined || w.judgedWeeks === 0 ? " · no judged weeks yet" : ` · advanced in ${w.advancedWeeks} of ${w.judgedWeeks} judged weeks`}
              </p>
              {tasks.length > 0 ? (
                <ul className="space-y-1.5">
                  {tasks.map((t) => (
                    <TaskRow key={t.id} task={t} />
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
      {refreshedAt === null ? null : <p className="text-[11px] text-muted-foreground">Tasks refreshed {relativeTime(refreshedAt)}.</p>}
      <ErrorNote message={error ?? goals.error} />
    </section>
  );
}
