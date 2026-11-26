// The Week tab: this week's intent and commitments (with the week's shape), last week's marks, whether the plans hit
// their marks, and the goals & tasks. Data: plan.get / set / now / accuracy, week.get (evidence links), goals.get.
import { useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { RpcContract } from "../../lib/contract";
import { previousWeeks } from "../../lib/engine/dates";
import type { PlanItem, PlanResult } from "../../lib/features/plan/types";
import type { EvidenceEntry, WeekPlan } from "../../lib/types";
import { Card, Empty, ErrorNote, errorText, Pill, StatTile, useAsync } from "../common";
import { safeHref } from "../safeHref";
import { GoalsTasks } from "./GoalsTasks";
import { dayName, KIND_ICON, MARKS, pct } from "./helpers";
import { HitRateTrend } from "./HitRateTrend";
import { PlanEditor } from "./PlanEditor";
import { WeekShape } from "./WeekShape";

function EvidenceChip({ id, entry }: { id: string; entry: EvidenceEntry | undefined }) {
  const cls = "rounded bg-muted px-1.5 font-mono text-[11px] text-muted-foreground";
  return entry?.link ? (
    <a href={safeHref(entry.link)} target="_blank" rel="noreferrer" title={entry.what} className={`${cls} hover:text-foreground`}>
      {id}
    </a>
  ) : (
    <span title={entry?.what} className={cls}>
      {id}
    </span>
  );
}

function RefChip({ r }: { r: PlanItem["refs"][number] }) {
  const cls = "inline-flex items-center gap-1 rounded bg-muted px-1.5 text-[11px] text-muted-foreground";
  const icon = r.kind === "meeting" ? "Calendar" : r.kind === "pr" ? "GitPullRequest" : r.kind === "doc" ? "FileText" : "Ticket";
  const text = r.kind === "meeting" && r.date ? `${dayName(r.date)} ${r.label}` : r.label;
  const href = r.url !== null && r.url.startsWith("https://") ? safeHref(r.url) : null;
  const body = (
    <>
      <Icon name={icon} className="size-3" />
      {text}
    </>
  );
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className={`${cls} hover:text-foreground`}>
      {body}
    </a>
  ) : (
    <span className={cls}>{body}</span>
  );
}

function Mark({ status }: { status: PlanResult["status"] | null }) {
  if (status === null) return <Pill>Not judged</Pill>;
  const s = MARKS[status];
  return (
    <Pill tone={s.tone}>
      <Icon name={s.icon} className="mr-1 size-3" />
      {s.label}
    </Pill>
  );
}

function Results({ items, results, evidence }: { items: PlanItem[]; results: PlanResult[]; evidence: EvidenceEntry[] }) {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  return (
    <ul className="space-y-2 text-sm">
      {items.map((item) => {
        const r = results.find((x) => x.itemId === item.id);
        return (
          <li key={item.id} className="space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <Mark status={r ? r.status : null} />
              <span>{item.text}</span>
              {item.carryCount > 0 ? <Pill>carried {item.carryCount}×</Pill> : null}
            </div>
            {item.doneWhen ? <div className="pl-1 text-xs text-muted-foreground">Mark: {item.doneWhen}</div> : null}
            {r && (r.note || r.evidenceIds.length > 0) ? (
              <div className="flex flex-wrap items-baseline gap-x-2 pl-1 text-xs text-muted-foreground">
                {r.note ? <span>{r.note}</span> : null}
                {r.evidenceIds.map((id) => (
                  <EvidenceChip key={id} id={id} entry={byId.get(id)} />
                ))}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function Commitments({ plan, areaLabel }: { plan: WeekPlan; areaLabel: Map<string, string> }) {
  return (
    <ul className="space-y-3 text-sm">
      {plan.items.map((i) => {
        const k = KIND_ICON[i.kind] ?? KIND_ICON.other!;
        return (
          <li key={i.id} className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span title={k.label} className="inline-flex items-center gap-1 text-muted-foreground">
                <Icon name={k.icon} className="size-4" />
                <span className="text-[11px]">{k.label}</span>
              </span>
              <span className="font-medium">{i.text}</span>
              {i.area ? <Pill>{areaLabel.get(i.area) ?? i.area}</Pill> : null}
              {i.carryCount > 0 ? <Pill>carried {i.carryCount}×</Pill> : null}
            </div>
            {i.doneWhen ? <div className="pl-6 text-xs text-muted-foreground">Done when: {i.doneWhen}</div> : null}
            {i.refs.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 pl-6">
                {i.refs.map((r, n) => (
                  <RefChip key={n} r={r} />
                ))}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function PlanTab() {
  const rpc = useRpc<RpcContract>();
  const grid = useAsync(() => rpc.call("grid.get", { weeks: 4 }), []);
  const week = grid.data?.currentWeek ?? null;
  const prevWeek = week === null ? null : previousWeeks(week, 1)[0]!;
  const plan = useAsync(() => (week === null ? Promise.resolve(null) : rpc.call("plan.get", { week })), [week]);
  const prev = useAsync(() => (prevWeek === null ? Promise.resolve(null) : rpc.call("plan.get", { week: prevWeek })), [prevWeek]);
  const prevReport = useAsync(() => (prevWeek === null ? Promise.resolve(null) : rpc.call("week.get", { week: prevWeek })), [prevWeek]);
  const accuracy = useAsync(() => rpc.call("plan.accuracy", { weeks: 12 }), []);
  const goals = useAsync(() => rpc.call("goals.get"), []);
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);

  const stored = plan.data;
  if (!week || !stored) return <Empty>{grid.error ?? plan.error ?? "Loading the week…"}</Empty>;
  const areaLabel = new Map((grid.data?.areas ?? []).map((a) => [a.key, a.label]));
  const goalText = new Map((goals.data?.goals ?? []).map((g) => [g.id, g.text]));
  const byAgent = stored.items.some((i) => i.source === "inferred");
  const planNow = () => {
    setAsking(true);
    setAskError(null);
    rpc.call("plan.now", { week }).catch((cause: unknown) => setAskError(errorText(cause)));
  };
  // The scan runs in the background and publishes; the realtime channel re-reads the plan.
  if (asking && stored.items.length > 0) setAsking(false);
  const prevPlan = prev.data;

  return (
    <div className="space-y-4">
      <ErrorNote message={accuracy.error ?? askError} />
      <Card title={`This week, ${week}`} aside="The intent, what the week is meant to get done, and what it looks like on the calendar.">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {byAgent ? <Pill>planned by your agent</Pill> : null}
          {stored.items.length > 0 ? (
            <Button variant="outline" size="sm" className="ml-auto" onClick={() => setEditing(!editing)}>
              <Icon name={editing ? "Check" : "Pencil"} className="size-3.5" />
              {editing ? "Done" : "Edit"}
            </Button>
          ) : null}
        </div>
        {editing ? (
          <PlanEditor week={week} onSaved={() => { plan.reload(); accuracy.reload(); }} />
        ) : stored.items.length === 0 ? (
          <div className="space-y-2">
            <p className="text-base font-medium">Not planned yet</p>
            <p className="text-sm text-muted-foreground">Your agent plans the week automatically on Monday at 07:00, from your calendar, your backlog and your goals.</p>
            <Button size="sm" disabled={asking} onClick={planNow}>
              <Icon name="ListChecks" className="size-3.5" />
              {asking ? "Planning…" : "Plan this week"}
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {stored.intent ? (
              <div className="space-y-1.5">
                <h2 className="text-xl font-semibold leading-snug">{stored.intent.headline}</h2>
                {stored.intent.why ? <p className="text-sm text-muted-foreground">{stored.intent.why}</p> : null}
                {stored.intent.focusGoalIds.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {stored.intent.focusGoalIds.map((id) => (
                      <Pill key={id}>
                        <Icon name="Target" className="mr-1 size-3" />
                        {goalText.get(id) ?? id}
                      </Pill>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            <Commitments plan={stored} areaLabel={areaLabel} />
            {stored.shape ? (
              <div className="border-t border-border pt-3">
                <div className="mb-1.5 text-xs font-medium text-muted-foreground">Week shape</div>
                <WeekShape shape={stored.shape} />
              </div>
            ) : null}
            {stored.backlog && stored.backlog.deferred.length > 0 ? (
              <details className="border-t border-border pt-3 text-sm">
                <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                  Deferred from backlog ({stored.backlog.deferred.length} of {stored.backlog.considered} considered)
                </summary>
                <ul className="mt-1.5 space-y-0.5">
                  {stored.backlog.deferred.map((d, n) => (
                    <li key={n}>
                      {d.label}
                      {d.why ? <span className="text-xs text-muted-foreground"> · {d.why}</span> : null}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        )}
        {stored.judgedAt !== null && stored.items.length > 0 ? (
          <div className="mt-3 border-t border-border pt-3">
            <Results items={stored.items} results={stored.results} evidence={[]} />
          </div>
        ) : null}
      </Card>

      <Card title={`Last week's marks, ${prevWeek}`} aside="Each commitment as the end-of-week review marked it against its Done when, with the evidence behind it.">
        {prevPlan && prevPlan.items.length > 0 ? (
          <div className="space-y-3">
            {prevPlan.hitRate !== null ? (
              <div className="flex flex-wrap items-end gap-6">
                <StatTile label="Hit rate" value={pct(prevPlan.hitRate)} />
                {prevPlan.unplannedShare !== null ? <StatTile label="Unplanned work" value={pct(prevPlan.unplannedShare)} /> : null}
              </div>
            ) : null}
            <Results items={prevPlan.items} results={prevPlan.results} evidence={prevReport.data?.week?.evidence ?? []} />
            {prevPlan.retro ? (
              <div className="space-y-1 border-t border-border pt-3 text-sm">
                {prevPlan.retro.summary ? <p>{prevPlan.retro.summary}</p> : null}
                {prevPlan.retro.derailers.length > 0 ? (
                  <ul className="space-y-0.5">
                    {prevPlan.retro.derailers.map((d, n) => (
                      <li key={n} className="flex flex-wrap items-baseline gap-x-2">
                        <Icon name="TriangleAlert" className="size-3.5 self-center text-muted-foreground" />
                        <span>Derailed by: {d.text}</span>
                        {d.evidenceIds.map((id) => (
                          <EvidenceChip key={id} id={id} entry={(prevReport.data?.week?.evidence ?? []).find((e) => e.id === id)} />
                        ))}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            {prevPlan.unplannedShare !== null ? (
              <p className="text-xs text-muted-foreground">Unplanned work: {pct(prevPlan.unplannedShare)} of the week's substantive work was not part of any commitment.</p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No commitments were set last week.</p>
        )}
      </Card>

      <Card title="Is it hitting its marks?" aside="Hit rate = (hit + half of partial) / (commitments − dropped), per judged week.">
        <p className="mb-2 text-sm">{accuracy.data?.note ?? "Loading…"}</p>
        <HitRateTrend byWeek={accuracy.data?.byWeek ?? []} />
        {accuracy.data && accuracy.data.byWeek.length > 0 ? (
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
            {accuracy.data.byWeek.map((w) => (
              <li key={w.week}>
                {w.week.slice(5)}: {w.hit} hit of {w.committed}
                {w.hitRate !== null ? ` (${pct(w.hitRate)})` : ""}
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      <GoalsTasks />
    </div>
  );
}
