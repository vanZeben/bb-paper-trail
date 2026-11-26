import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { RpcContract } from "../../lib/contract";
import type { AreaSnapshot, Claim, GuardrailResult, OverrideTarget, WeekAddenda, WeekMix, WeekPlan, WorkWeek, WorklogStatus } from "../../lib/types";
import { Card, Empty, errorText, ErrorNote, Pill, StatTile, useAsync } from "../common";
import { areaLabel, downloadText, formatHours, formatPct, isBusyKey, RATING_LABEL } from "./helpers";
import { OverrideContext, type OverrideInfo } from "./overrideContext";
import { CoverageLine, EvidenceId, EvidenceRow, RatingPill, ratingTone } from "./parts";
import { useRun } from "./useRun";

type RenderOverride = (target: OverrideTarget) => ReactNode;

const PLAN_STATUS: Record<string, string> = { done: "Done", partial: "Partial", not_done: "Not done", dropped: "Dropped" };
const SEVERITY_TONE: Record<string, string> = { info: "bg-muted text-muted-foreground", warning: "bg-amber-500/15 text-amber-700 dark:text-amber-300", breach: "bg-red-500/15 text-red-700 dark:text-red-300" };

/** "My notes": a textarea saved through addenda.set, plus the work the user claimed from the radar. */
function Addenda({ week, addenda, onError }: { week: string; addenda: WeekAddenda; onError: (message: string | null) => void }) {
  const rpc = useRpc<RpcContract>();
  const [text, setText] = useState(addenda.myNotes);
  const [saving, setSaving] = useState(false);
  useEffect(() => setText(addenda.myNotes), [addenda.myNotes, week]);
  const dirty = text !== addenda.myNotes;
  const save = async () => {
    setSaving(true);
    onError(null);
    try {
      await rpc.call("addenda.set", { week, myNotes: text });
    } catch (cause) {
      onError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card title="My notes" aside="Things you did that the sources do not show. They go into the week's markdown and your review packet.">
      <textarea
        value={text}
        maxLength={8000}
        onChange={(event) => setText(event.target.value)}
        rows={4}
        aria-label={`Notes for ${week}`}
        className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm"
      />
      <div className="mt-2 flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={!dirty || saving} onClick={() => void save()}>
          <Icon name={saving ? "Loader" : "Save"} className="size-3.5" />
          Save notes
        </Button>
        {dirty ? <span className="text-xs text-muted-foreground">Unsaved changes</span> : null}
      </div>
      {addenda.claimedWork.length > 0 ? (
        <div className="mt-3">
          <h4 className="mb-1 text-xs font-semibold text-muted-foreground">Work you claimed</h4>
          <ul className="space-y-1.5 text-sm">
            {addenda.claimedWork.map((c, n) => (
              <li key={n} className="flex flex-wrap items-baseline gap-x-2">
                <span>{c.text}</span>
                {c.evidenceIds.map((id) => (
                  <EvidenceId key={id} id={id} />
                ))}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}

function PlanResults({ plan }: { plan: Pick<WeekPlan, "items" | "results" | "hitRate"> }) {
  if (plan.items.length === 0) return null;
  const results = new Map(plan.results.map((r) => [r.itemId, r]));
  return (
    <Card title="Plan results" aside={plan.hitRate === null ? "Not judged yet." : `Hit rate ${formatPct(plan.hitRate * 100)}`}>
      <ul className="space-y-1.5 text-sm">
        {plan.items.map((item) => {
          const r = results.get(item.id);
          return (
            <li key={item.id} className="flex flex-wrap items-baseline gap-x-2">
              <Pill>{r ? PLAN_STATUS[r.status] ?? r.status : "Pending"}</Pill>
              <span>{item.text}</span>
              {r?.note ? <span className="text-muted-foreground">— {r.note}</span> : null}
              {(r?.evidenceIds ?? []).map((id) => (
                <EvidenceId key={id} id={id} />
              ))}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function Violations({ items }: { items: GuardrailResult[] }) {
  if (items.length === 0) return null;
  return (
    <Card title="Guardrails">
      <ul className="space-y-1.5 text-sm">
        {items.map((v) => (
          <li key={v.id} className="flex flex-wrap items-baseline gap-x-2">
            <Pill tone={SEVERITY_TONE[v.severity]}>{v.severity}</Pill>
            <span className="font-medium">{v.title}</span>
            <span className="text-muted-foreground">{v.detail}</span>
            {v.state !== "open" ? <Pill>{v.state}</Pill> : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function MixCard({ mix, labels }: { mix: WeekMix; labels: readonly AreaSnapshot[] }) {
  const entries = Object.entries(mix.actual).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  return (
    <Card title="Time mix" aside={mix.drift === null ? "No target set." : `Largest gap to target: ${Math.round(mix.drift * 10) / 10} points`}>
      <ul className="space-y-1 text-sm">
        {entries.map(([area, pct]) => (
          <li key={area} className="flex justify-between gap-2">
            <span>{areaLabel(labels, area)}</span>
            <span className="tabular-nums text-muted-foreground">{formatPct(pct)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export interface WeekPanelProps {
  week: string;
  status: WorklogStatus;
  /** Area labels from the `grid.get` payload; a week's own snapshot takes precedence for that week. */
  areas: readonly AreaSnapshot[];
  onClose: () => void;
  onError: (message: string | null) => void;
  /** Slot for the confirm/override control. Rendered with the week's target, and with each scorecard row's target. */
  renderOverride?: RenderOverride;
}

function Claims({ title, items, empty }: { title: string; items: Claim[]; empty?: string }) {
  return (
    <Card title={title}>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty ?? "Nothing recorded."}</p>
      ) : (
        <ul className="space-y-1.5 text-sm">
          {items.map((c, n) => (
            <li key={n} className="flex flex-wrap items-baseline gap-x-2">
              <span>{c.text}</span>
              {c.evidenceIds.map((id) => (
                <EvidenceId key={id} id={id} />
              ))}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const STATUS_ICON = { hit: "CircleCheck", partial: "Circle", missed: "CircleX" } as const;
const STATUS_TONE = { hit: "text-emerald-600", partial: "text-amber-500", missed: "text-red-500" } as const;

interface Extras {
  plan: WeekPlan | null;
  violations: GuardrailResult[];
  addenda: WeekAddenda;
  mix: WeekMix | null;
  onError: (message: string | null) => void;
}

function WeekBody({ week, areas, renderOverride, extras }: { week: WorkWeek; areas: readonly AreaSnapshot[]; renderOverride?: RenderOverride; extras: Extras }) {
  const [showEvidence, setShowEvidence] = useState(false);
  const m = week.meetings;
  const labels = week.areasSnapshot.length > 0 ? week.areasSnapshot : areas;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile label="Days worked" value={week.daysWorked} icon="Clock" />
        <StatTile label="Meetings" value={m.count} icon="Users" hint={`${m.passiveCount} passive`} />
        <StatTile label="Meeting hours" value={formatHours(m.hours)} />
        <StatTile label="% of week" value={formatPct(m.pctOfWeek)} />
      </div>
      <Card title="Week in three lines">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {week.threeLines.map((line, n) => (
            <li key={n}>{line}</li>
          ))}
        </ul>
        <p className="mt-2 text-sm text-muted-foreground">{week.ratingReason}</p>
        <ul className="mt-3 space-y-1 text-xs">
          {week.days.map((d) => (
            <li key={d.date} className="flex items-start gap-2">
              <span className="w-20 shrink-0 tabular-nums text-muted-foreground">{d.date.slice(5)}</span>
              <span className="w-32 shrink-0">
                <Pill tone={ratingTone[d.rating]}>{RATING_LABEL[d.rating]}</Pill>
              </span>
              <span className="min-w-0 flex-1 text-muted-foreground">{d.summary}</span>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Scorecard">
        <ul className="space-y-1.5 text-sm">
          {week.scorecard.map((s) => (
            <li key={s.area} className="flex items-start gap-2">
              <Icon name={STATUS_ICON[s.status]} className={cn("mt-0.5 size-4 shrink-0", STATUS_TONE[s.status])} />
              <span className="min-w-0 flex-1">
                <span className="font-medium">{areaLabel(labels, s.area)}</span>
                <span className="text-muted-foreground"> — {s.note}</span>
                {s.evidenceIds.map((id) => (
                  <span key={id} className="ml-1.5">
                    <EvidenceId id={id} />
                  </span>
                ))}
                {renderOverride ? <div className="mt-1">{renderOverride({ type: "scorecard", week: week.week, area: s.area })}</div> : null}
              </span>
            </li>
          ))}
        </ul>
      </Card>
      <PlanResults plan={extras.plan ?? { items: [], results: [], hitRate: null }} />
      <Violations items={extras.violations} />
      {extras.mix ? <MixCard mix={extras.mix} labels={labels} /> : null}
      <Claims title="Shipped" items={week.shipped} />
      <Claims title="In progress" items={week.inProgress} />
      <Claims title="Decisions & influence" items={week.decisions} />
      <Claims title="Helping others" items={week.helping} />
      <Card title="Meetings">
        <p className="text-sm">
          {m.count} meetings · {formatHours(m.hours)} · {formatPct(m.pctOfWeek)} of the week · {m.passiveCount} passive
        </p>
        {m.topSinks.length > 0 ? (
          <ul className="mt-2 space-y-0.5 text-sm">
            {m.topSinks.map((s) => (
              <li key={s.title} className="flex justify-between gap-2">
                <span className="min-w-0 truncate">{s.title}</span>
                <span className="text-muted-foreground">{formatHours(s.hours)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
      <Claims title="Recognition" items={week.recognition} />
      <Claims title="Open asks" items={week.openAsks} />
      <Claims title="Friction" items={week.friction} />
      {/* The manager's name is not in the week payload, so the title is generic. */}
      <Claims title="Worth raising with your manager" items={week.raiseWithManager} />
      <Addenda week={week.week} addenda={extras.addenda} onError={extras.onError} />
      <Card title="Reflection">
        <p className="mb-1.5">
          <Pill tone={week.reflection.goodWeek ? ratingTone.meets : ratingTone.needs_improvement}>{week.reflection.goodWeek ? "good week" : "not a good week"}</Pill>
        </p>
        <p className="text-sm">{week.reflection.text}</p>
      </Card>
      <section>
        <Button variant="ghost" size="sm" onClick={() => setShowEvidence((v) => !v)}>
          <Icon name={showEvidence ? "EyeOff" : "Eye"} className="size-3.5" />
          Evidence record ({week.evidence.length})
        </Button>
        {showEvidence ? (
          <ul className="mt-2 space-y-1.5 rounded-lg border border-border bg-card p-3.5">
            {week.evidence.map((e) => (
              <li key={e.id} className="flex gap-2 text-sm">
                <span className="w-12 shrink-0 text-xs tabular-nums text-muted-foreground">{e.date.slice(5)}</span>
                <EvidenceRow entry={e} />
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

export function WeekPanel({ week, status, areas, onClose, onError, renderOverride }: WeekPanelProps) {
  const rpc = useRpc<RpcContract>();
  const report = useAsync(() => rpc.call("week.get", { week }), [week]);
  const run = useRun(onError);
  const [downloading, setDownloading] = useState(false);
  const busy = isBusyKey(status, `week:${week}`);
  const data = report.data?.week ?? null;
  const overrides = report.data?.overrides ?? [];
  // The header shows what the user stands behind: the week override value when there is one, else the AI rating.
  const effectiveRating = (data === null ? null : ((overrides.find((o) => o.id === `week:${week}`)?.value ?? data.rating) as WorkWeek["rating"]));
  const lookup = (target: OverrideTarget): OverrideInfo => {
    if (target.type === "week") return { ai: data?.rating ?? null, override: overrides.find((o) => o.id === `week:${week}`) ?? null };
    if (target.type === "scorecard") {
      return { ai: data?.scorecard.find((s) => s.area === target.area)?.status ?? null, override: overrides.find((o) => o.id === `scorecard:${week}:${target.area}`) ?? null };
    }
    return { ai: null, override: null };
  };
  const extras: Extras = {
    plan: report.data?.plan ?? null,
    violations: report.data?.violations ?? [],
    addenda: report.data?.addenda ?? { week, myNotes: "", claimedWork: [], raiseWithManager: [], updatedAt: "" },
    mix: report.data?.mix ?? null,
    onError,
  };

  const download = async () => {
    setDownloading(true);
    onError(null);
    try {
      const { markdown, filename } = await rpc.call("week.markdown", { week });
      downloadText(filename, markdown);
    } catch (cause) {
      onError(errorText(cause));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">{week}</h2>
        {data ? (
          <>
            <span className="text-xs text-muted-foreground">
              {data.from} → {data.to}
            </span>
            <RatingPill rating={effectiveRating ?? data.rating} />
            {!data.final ? <Pill>not final</Pill> : null}
          </>
        ) : null}
        <span className="flex-1" />
        {data ? (
          <Button variant="outline" size="sm" disabled={downloading} onClick={() => void download()}>
            <Icon name={downloading ? "Loader" : "Download"} className="size-3.5" />
            Download markdown
          </Button>
        ) : null}
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void run({ kind: "week", week, recapture: data !== null })}>
          <Icon name={busy ? "Loader" : "RefreshCw"} className="size-3.5" />
          {data ? "Re-run week" : "Run week"}
        </Button>
        <Button variant="ghost" size="sm" aria-label="Close" onClick={onClose}>
          <Icon name="X" className="size-3.5" />
        </Button>
      </div>
      <ErrorNote message={report.error} />
      {data ? <CoverageLine coverage={data.coverage} /> : null}
      {data && renderOverride ? (
        <OverrideContext.Provider value={lookup}>
          {renderOverride({ type: "week", week })}
          <WeekBody week={data} areas={areas} renderOverride={renderOverride} extras={extras} />
        </OverrideContext.Provider>
      ) : data ? (
        <WeekBody week={data} areas={areas} extras={extras} />
      ) : report.loading ? null : (
        <>
          <Empty>No report for this week yet. Use the run button above.</Empty>
          <Addenda week={week} addenda={extras.addenda} onError={extras.onError} />
        </>
      )}
    </div>
  );
}
