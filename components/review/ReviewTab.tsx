import { useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { RpcContract } from "../../lib/contract";
import type { EvidenceRef, ReviewPacket } from "../../lib/types";
import { Card, Empty, errorText, ErrorNote, Pill, Segmented, StatTile, useAsync } from "../common";
import { downloadText, RATING_COLOR, RATING_LABEL } from "../graph/helpers";
import { safeHref } from "../safeHref";
import { localDate, presetRange, RANGE_OPTIONS, type RangePreset } from "./ranges";

const STATUS = {
  hit: { label: "Hit", symbol: "✓", className: "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300" },
  partial: { label: "Partial", symbol: "◐", className: "bg-amber-500/20 text-amber-700 dark:text-amber-300" },
  missed: { label: "Missed", symbol: "✕", className: "bg-red-500/20 text-red-700 dark:text-red-300" },
} as const;

function Chips({ refs }: { refs: readonly EvidenceRef[] }) {
  if (refs.length === 0) return <span className="text-[11px] text-muted-foreground">no evidence cited</span>;
  return (
    <>
      {refs.map((r) =>
        r.link === null ? (
          <span key={`${r.date}|${r.id}`} title={r.date} className="rounded bg-muted px-1.5 font-mono text-[11px] text-muted-foreground">
            {r.id}
          </span>
        ) : (
          <a key={`${r.date}|${r.id}`} href={safeHref(r.link)} target="_blank" rel="noreferrer" title={`${r.date}: open source`} className="rounded bg-muted px-1.5 font-mono text-[11px] text-foreground hover:underline">
            {r.id}
          </a>
        ),
      )}
    </>
  );
}

function ClaimCard({ title, items, empty }: { title: string; items: ReviewPacket["decisions"]; empty: string }) {
  return (
    <Card title={title}>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {items.map((c, n) => (
            <li key={n} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-xs tabular-nums text-muted-foreground">{c.week}</span>
              <span>{c.text}</span>
              <Chips refs={c.evidence} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function GoalsCard({ goals }: { goals: ReviewPacket["goals"] }) {
  if (goals.length === 0) return null;
  return (
    <Card title="Goals" aside="Judged each week from the evidence. Evidence chips are the weeks that advanced the goal.">
      <ul className="space-y-3 text-sm">
        {goals.map((g) => {
          const refs = g.weeks.filter((w) => w.status === "advanced").flatMap((w) => w.evidence);
          return (
            <li key={g.goalId} className="space-y-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">{g.text}</span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {g.judgedWeeks === 0 ? "not judged yet" : `advanced in ${g.advancedWeeks} of ${g.judgedWeeks} weeks`}
                </span>
              </div>
              {refs.length > 0 ? (
                <div className="flex flex-wrap items-baseline gap-1.5">
                  <Chips refs={refs} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function UncreditedCard({ items }: { items: ReviewPacket["uncreditedWork"] }) {
  if (items.length === 0) return null;
  return (
    <Card title="Work no weekly summary mentioned" aside="Found in your sources but never claimed. Handle it from the radar in the Threads tab.">
      <ul className="space-y-3 text-sm">
        {items.map((u) => (
          <li key={u.id} className="space-y-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{u.label}</span>
              <span className="text-xs text-muted-foreground">
                {u.count} item{u.count === 1 ? "" : "s"} · {u.weeks.join(", ")}
              </span>
            </div>
            <div className="flex flex-wrap items-baseline gap-1.5">
              <Chips refs={u.items} />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Distribution({ packet }: { packet: ReviewPacket }) {
  const order = ["exceeds", "meets", "needs_improvement"] as const;
  const total = order.reduce((a, k) => a + (packet.ratingDistribution[k] ?? 0), 0);
  return (
    <Card title="Rating distribution" aside="Days, with your overrides applied.">
      {total === 0 ? (
        <p className="text-sm text-muted-foreground">No rated days in this range.</p>
      ) : (
        <>
          <div className="flex h-4 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={order.map((k) => `${RATING_LABEL[k]} ${packet.ratingDistribution[k] ?? 0}`).join(", ")}>
            {order.map((k) => {
              const n = packet.ratingDistribution[k] ?? 0;
              return n === 0 ? null : <div key={k} title={`${RATING_LABEL[k]}: ${n}`} style={{ width: `${(100 * n) / total}%`, backgroundColor: RATING_COLOR[k] }} />;
            })}
          </div>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {order.map((k) => (
              <li key={k} className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-sm" style={{ backgroundColor: RATING_COLOR[k] }} aria-hidden />
                {RATING_LABEL[k]} <span className="tabular-nums text-muted-foreground">{packet.ratingDistribution[k] ?? 0}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function Heatmap({ packet }: { packet: ReviewPacket }) {
  if (packet.heatmap.length === 0 || packet.weeks.length === 0) return null;
  return (
    <Card title="Scorecard by week" aside="Area by week. ● marks a cell you changed.">
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-1 text-xs">
          <thead>
            <tr>
              <th className="text-left font-medium text-muted-foreground">Area</th>
              {packet.weeks.map((w) => (
                <th key={w} className="px-1 text-center font-normal tabular-nums text-muted-foreground">
                  {w.slice(6)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {packet.heatmap.map((a) => (
              <tr key={a.area}>
                <td className="whitespace-nowrap pr-2">{a.label}</td>
                {a.cells.map((c) => {
                  const s = c.status === null ? null : STATUS[c.status];
                  return (
                    <td
                      key={c.week}
                      title={`${a.label} ${c.week}: ${s?.label ?? "no data"}${c.overridden ? " (changed by you)" : ""}`}
                      className={cn("h-7 min-w-8 rounded text-center", s?.className ?? "bg-muted text-muted-foreground")}
                    >
                      {s === null ? "–" : s.symbol}
                      {c.overridden ? <span aria-label="changed by you">●</span> : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {(Object.keys(STATUS) as Array<keyof typeof STATUS>).map((k) => (
          <li key={k}>
            <span className={cn("mr-1 inline-block min-w-5 rounded px-1 text-center", STATUS[k].className)}>{STATUS[k].symbol}</span>
            {STATUS[k].label}
          </li>
        ))}
        <li>– no data</li>
        <li>● changed by you</li>
      </ul>
    </Card>
  );
}

export function ReviewTab() {
  const rpc = useRpc<RpcContract>();
  const today = useMemo(() => localDate(), []);
  const [preset, setPreset] = useState<RangePreset>("this_quarter");
  const [custom, setCustom] = useState(() => presetRange("this_quarter", today));
  const range = preset === "custom" ? custom : presetRange(preset, today);
  const valid = range.from <= range.to && /^\d{4}-\d{2}-\d{2}$/.test(range.from) && /^\d{4}-\d{2}-\d{2}$/.test(range.to);

  const packetState = useAsync(() => (valid ? rpc.call("packet.build", range) : Promise.reject(new Error("The start date must not be after the end date."))), [range.from, range.to, valid]);
  const connectors = useAsync(() => rpc.call("connectors.get", null), []);
  // An invalid range never shows a stale packet and never enables export, note or draft.
  const packet = valid ? packetState.data : null;
  const vaultAvailable = connectors.data?.check?.sources.vault?.available === true;

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [notePath, setNotePath] = useState("");
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => setNotePath(`reviews/review-${range.from}-to-${range.to}.md`), [range.from, range.to]);
  // The server reports the draft's state with the packet (idle, running, ready, failed) and announces changes on the channel.
  const drafting = packet?.narrativeStatus === "running" ? true : null;
  const draftFailed = packet?.narrativeStatus === "failed";

  const run = async (key: string, task: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await task();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };
  const markdown = (includeNarrative: boolean) => rpc.call("packet.markdown", { ...range, includeNarrative });
  const withNarrative = packet?.narrative != null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented label="Review range" value={preset} options={RANGE_OPTIONS} onChange={setPreset} />
        {preset === "custom" ? (
          <div className="flex items-center gap-1.5 text-sm">
            <Input type="date" aria-label="From" className="h-8 w-40" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
            <span className="text-muted-foreground">to</span>
            <Input type="date" aria-label="To" className="h-8 w-40" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
          </div>
        ) : (
          <span className="text-xs tabular-nums text-muted-foreground">
            {range.from} to {range.to}
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">AI-rated; your overrides applied; gaps listed.</p>
      <ErrorNote message={error ?? packetState.error} />

      {!valid ? <p className="text-sm text-muted-foreground">Pick a valid range to build the packet.</p> : packet === null ? (
        packetState.loading ? <p className="text-sm text-muted-foreground">Building your review packet…</p> : null
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={!valid || busy !== null} onClick={() => run("download", async () => { const d = await markdown(withNarrative); downloadText(d.filename, d.markdown); })}>
              <Icon name="Download" className="size-3.5" /> Download markdown
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!valid || busy !== null}
              onClick={() =>
                run("copy", async () => {
                  await navigator.clipboard.writeText((await markdown(withNarrative)).markdown);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                })
              }
            >
              <Icon name="Copy" className="size-3.5" /> {copied ? "Copied" : "Copy"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!valid || busy !== null || drafting !== null}
              onClick={() => run("draft", async () => { await rpc.call("packet.narrative.start", range); packetState.reload(); })}
            >
              <Icon name={drafting === null ? "Sparkles" : "Loader"} className="size-3.5" /> {drafting === null ? (withNarrative ? "Redraft narrative" : "Draft narrative") : "Drafting…"}
            </Button>
          </div>
          {vaultAvailable ? (
            <div className="flex flex-wrap items-center gap-2">
              <Input aria-label="Note path" className="h-8 min-w-0 max-w-md flex-1" value={notePath} onChange={(e) => setNotePath(e.target.value)} />
              <Button
                size="sm"
                variant="outline"
                disabled={!valid || busy !== null || notePath.trim() === ""}
                onClick={() => run("note", async () => { await rpc.call("packet.writeNote", { ...range, path: notePath.trim() }); setSaved(notePath.trim()); })}
              >
                <Icon name={busy === "note" ? "Loader" : "FileText"} className="size-3.5" /> Save to notes
              </Button>
              {saved !== null ? <span className="text-xs text-muted-foreground">Saved to {saved}</span> : null}
            </div>
          ) : null}

          {draftFailed ? <p className="text-xs text-destructive">The last narrative draft did not finish. Check the capture host and try again.</p> : null}
          {packet.narrative !== null ? (
            <Card title="Self-assessment draft" aside="Drafted by a model from this packet only. Citations are evidence ids. Edit before use.">
              <div className="space-y-2 text-sm">
                {packet.narrative.split("\n\n").map((p, n) => (
                  <p key={n}>{p}</p>
                ))}
              </div>
            </Card>
          ) : null}

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StatTile label="Shipped" value={packet.shipped.length} icon="Rocket" />
            <StatTile label="Decisions" value={packet.decisions.length} />
            <StatTile label="Helping others" value={packet.helpGiven.length} />
            <StatTile label="Plan hit rate" value={packet.plan.hitRate === null ? "–" : `${Math.round(packet.plan.hitRate * 100)}%`} hint={`${packet.overrides.reviewed} ratings reviewed`} />
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <Distribution packet={packet} />
            <Card title="Week ratings">
              {packet.weekRatings.length === 0 ? (
                <p className="text-sm text-muted-foreground">No weekly summaries in this range yet.</p>
              ) : (
                <ul className="flex flex-wrap gap-1.5">
                  {packet.weekRatings.map((w) => (
                    <li key={w.week}>
                      <Pill>
                        {w.week.slice(5)} · {RATING_LABEL[w.rating as keyof typeof RATING_LABEL] ?? w.rating}
                        {w.final ? "" : " (not final)"}
                      </Pill>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
          <Heatmap packet={packet} />
          <GoalsCard goals={packet.goals} />

          <Card title="Shipped">
            {packet.shipped.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing marked shipped in this range.</p>
            ) : (
              <ul className="space-y-3 text-sm">
                {packet.shipped.map((s, n) => (
                  <li key={`${s.threadId ?? "w"}-${n}`}>
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <span className="font-medium">{s.title}</span>
                      <span className="text-xs text-muted-foreground">{s.weeks.join(", ")}</span>
                      <Chips refs={s.evidence} />
                    </div>
                    {s.closure !== null ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Outcome: {s.closure.outcome.replace("_", " ")}. {s.closure.result} Learned: {s.closure.learnings}
                      </p>
                    ) : s.threadId !== null ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">No closure note yet.</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <div className="grid gap-3 lg:grid-cols-2">
            <ClaimCard title="Influence and decisions" items={packet.decisions} empty="No decisions recorded." />
            <ClaimCard title="Helping others" items={packet.helpGiven} empty="No help recorded." />
            <ClaimCard title="Recognition" items={packet.recognition} empty="No recognition recorded." />
            <ClaimCard title="Work I added myself" items={packet.claimedWork} empty="Claim invisible work from the Threads tab to see it here." />
          </div>

          <UncreditedCard items={packet.uncreditedWork} />

          <div className="grid gap-3 lg:grid-cols-2">
            <Card title="Time mix vs target">
              {packet.drift === null ? (
                <p className="text-sm text-muted-foreground">No time targets or mix data for this range.</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {Object.keys(packet.drift.target).map((k) => (
                    <li key={k} className="flex justify-between gap-2">
                      <span>{packet.heatmap.find((a) => a.area === k)?.label ?? k}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {packet.drift!.actual[k] ?? 0}% of {packet.drift!.target[k]}% target ({(packet.drift!.perArea[k] ?? 0) > 0 ? "+" : ""}
                        {packet.drift!.perArea[k] ?? 0} pts)
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Plan follow-through">
              {packet.plan.hitRate === null ? (
                <p className="text-sm text-muted-foreground">No judged weekly plans in this range.</p>
              ) : (
                <p className="text-sm">
                  Hit rate {Math.round(packet.plan.hitRate * 100)}%.
                  {packet.plan.carriedOver.length > 0 ? ` Carried over: ${packet.plan.carriedOver.join("; ")}.` : ""}
                </p>
              )}
            </Card>
          </div>

          <Card title="Gaps in the record" aside="An empty source is not proof of no work. Sources you turned off are not listed.">
            {packet.coverageGaps.length === 0 ? (
              <p className="text-sm text-muted-foreground">No failed or partial sources.</p>
            ) : (
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {packet.coverageGaps.map((g, n) => (
                  <li key={n}>{g}</li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
      {packet === null && !packetState.loading && packetState.error === null ? <Empty>No data in this range.</Empty> : null}
    </div>
  );
}
