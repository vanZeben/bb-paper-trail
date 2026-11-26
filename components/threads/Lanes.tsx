// Timeline lanes: one row per thread across the weeks. In-progress weeks are an outlined bar, shipped weeks a solid bar
// with a check, so state never relies on colour alone. A row expands to its evidence and the edit controls.
import { useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { RpcContract } from "../../lib/contract";
import type { ClosureNote, Thread } from "../../lib/types";
import { errorText, ErrorNote, Pill } from "../common";
import { safeHref } from "../safeHref";

export const STATUS_LABEL: Record<Thread["status"], string> = {
  active: "Active",
  at_risk: "At risk",
  shipped: "Shipped",
  closed: "Closed",
  stale: "Stale",
  dropped: "Dropped",
};
const STATUS_TONE: Record<Thread["status"], string> = {
  active: "bg-blue-500/15 text-blue-800 dark:text-blue-300",
  at_risk: "bg-orange-500/20 text-orange-800 dark:text-orange-300",
  shipped: "bg-green-700/20 text-green-800 dark:text-green-300",
  closed: "bg-muted text-foreground",
  stale: "bg-muted text-muted-foreground",
  dropped: "bg-muted text-muted-foreground line-through",
};

function Editor({ thread, others, onDone }: { thread: Thread; others: Thread[]; onDone: () => void }) {
  const rpc = useRpc<RpcContract>();
  const [title, setTitle] = useState(thread.title);
  const [merge, setMerge] = useState("");
  const [reason, setReason] = useState("");
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const send = async (patch: { title?: string; mergeInto?: string; hidden?: boolean; extraKeys?: string[]; drop?: { reason: string } }) => {
    try {
      setError(null);
      await rpc.call("threads.edit", { threadId: thread.id, title: patch.title ?? null, mergeInto: patch.mergeInto ?? null, hidden: patch.hidden ?? null, extraKeys: patch.extraKeys ?? [], drop: patch.drop ?? null });
      onDone();
    } catch (cause) {
      setError(errorText(cause));
    }
  };
  const input = "h-8 rounded-md border border-border bg-background px-2 text-xs";
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/30 p-2.5 text-xs">
      <ErrorNote message={error} />
      <div className="flex flex-wrap items-center gap-2">
        <input className={cn(input, "min-w-48 flex-1")} value={title} maxLength={120} aria-label="Thread title" onChange={(e) => setTitle(e.target.value)} />
        <Button size="sm" variant="outline" disabled={title.trim() === "" || title === thread.title} onClick={() => void send({ title })}>
          Rename
        </Button>
        <Button size="sm" variant="outline" onClick={() => void send({ hidden: !thread.hidden })}>
          {thread.hidden ? "Unhide" : "Hide"}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select className={cn(input, "w-56")} value={merge} aria-label="Merge into" onChange={(e) => setMerge(e.target.value)}>
          <option value="">Merge into…</option>
          {others.map((o) => (
            <option key={o.id} value={o.id}>
              {o.title}
            </option>
          ))}
        </select>
        <Button size="sm" variant="outline" disabled={merge === ""} onClick={() => void send({ mergeInto: merge })}>
          Merge
        </Button>
        <input className={cn(input, "w-48")} value={key} placeholder="Add key, e.g. jira:ABC-1" aria-label="Extra key" onChange={(e) => setKey(e.target.value)} />
        <Button size="sm" variant="outline" disabled={key.trim() === ""} onClick={() => void send({ extraKeys: [key.trim()] })}>
          Add key
        </Button>
      </div>
      {thread.status !== "dropped" ? (
        <div className="flex flex-wrap items-center gap-2">
          <input className={cn(input, "min-w-48 flex-1")} value={reason} maxLength={200} placeholder="Why drop it? (required)" aria-label="Reason for dropping" onChange={(e) => setReason(e.target.value)} />
          <Button size="sm" variant="outline" disabled={reason.trim() === ""} onClick={() => void send({ drop: { reason: reason.trim() } })}>
            Drop thread
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function Lanes({
  threads,
  weeks,
  closures,
  onClose,
  onChanged,
}: {
  threads: Thread[];
  weeks: string[];
  closures: ClosureNote[];
  onClose: (thread: Thread) => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const cols = { gridTemplateColumns: `repeat(${weeks.length}, minmax(10px, 1fr))` };
  return (
    <div className="space-y-1.5" role="list" aria-label="Thread timeline">
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <div className="w-56 shrink-0 sm:w-72" />
        <div className="grid min-w-0 flex-1" style={cols}>
          {weeks.map((w, i) => (
            <span key={w} className="text-center">
              {i % 4 === 0 || i === weeks.length - 1 ? w.slice(6) : ""}
            </span>
          ))}
        </div>
      </div>
      {threads.map((t) => {
        const note = closures.find((c) => c.threadId === t.id);
        const expanded = open === t.id;
        return (
          <div key={t.id} role="listitem" className={cn("space-y-1.5", t.hidden && "opacity-60")}>
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : t.id)}
                className="flex w-56 shrink-0 items-center gap-1.5 text-left text-sm sm:w-72"
                title={t.title}
              >
                <Icon name={expanded ? "ChevronDown" : "ChevronRight"} className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{t.title}</span>
                <Pill tone={STATUS_TONE[t.status]} className="shrink-0">
                  {STATUS_LABEL[t.status]}
                </Pill>
              </button>
              <div className="grid min-w-0 flex-1 gap-px" style={cols}>
                {weeks.map((w) => {
                  const entries = t.weeks.filter((e) => e.week === w);
                  const shipped = entries.find((e) => e.state === "shipped");
                  const wip = entries.find((e) => e.state === "in_progress");
                  const e = shipped ?? wip;
                  if (!e) return <span key={w} className="h-5" />;
                  return (
                    <span
                      key={w}
                      title={`${w} · ${e.state === "shipped" ? "shipped" : "in progress"}: ${e.text}`}
                      className={cn(
                        "flex h-5 items-center justify-center rounded-sm text-[10px] leading-none",
                        shipped ? "bg-green-700 text-white" : "border-2 border-blue-500/70 bg-blue-500/20",
                      )}
                    >
                      {shipped ? "✓" : ""}
                    </span>
                  );
                })}
              </div>
            </div>
            {expanded ? (
              <div className="ml-5 space-y-2 text-xs">
                {t.droppedReason ? <p className="text-muted-foreground">Dropped: {t.droppedReason}</p> : null}
                <ul className="space-y-1">
                  {t.weeks.map((e) => (
                    <li key={`${e.week}-${e.state}`} className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-mono text-muted-foreground">{e.week}</span>
                      <span>{e.state === "shipped" ? "Shipped" : "In progress"}: {e.text}</span>
                      {e.evidenceIds.map((id) => (
                        <span key={id} className="rounded bg-muted px-1.5 font-mono text-[11px] text-muted-foreground">
                          {id}
                        </span>
                      ))}
                    </li>
                  ))}
                </ul>
                {t.links.some((l) => safeHref(l) !== undefined) ? (
                  <p className="flex flex-wrap gap-x-3">
                    {t.links.filter((l) => safeHref(l) !== undefined).map((l) => (
                      <a key={l} href={safeHref(l)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                        <Icon name="ExternalLink" className="size-3" />
                        {l.replace(/^https:\/\//, "").slice(0, 60)}
                      </a>
                    ))}
                  </p>
                ) : null}
                {note ? (
                  <div className="rounded-md border border-border p-2">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      Closure: {note.outcome.replace("_", " ")}
                      {note.source === "agent" ? <Pill>drafted by your agent</Pill> : null}
                    </p>
                    <p>Expected: {note.expectation}</p>
                    <p>Happened: {note.result}</p>
                    <p>Learned: {note.learnings}</p>
                    {note.impact ? <p>Impact: {note.impact}</p> : null}
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {t.status !== "dropped" ? (
                    <Button size="sm" variant="outline" onClick={() => onClose(t)}>
                      {note ? "Edit closure note" : "Write closure note"}
                    </Button>
                  ) : null}
                </div>
                <Editor thread={t} others={threads.filter((o) => o.id !== t.id)} onDone={onChanged} />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
