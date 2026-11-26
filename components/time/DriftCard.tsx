// Drift card: the current score and status, the biggest over and under in plain words, and a sparkline of the score.
import type { AllocationTargets, DriftSnapshot, WeekMix } from "../../lib/types";
import { driftSnapshot } from "../../lib/features/drift/snapshot";
import { Card, Pill } from "../common";
import { driftSentence, METHOD_NOTE, shortWeek, STATUS_LABEL, STATUS_TONE, type AreaInfo } from "./helpers";

/** Rolling score at each mix week (window = targets.windowWeeks, partial at the start). */
export function scoreSeries(mix: readonly WeekMix[], targets: AllocationTargets): Array<{ week: string; score: number | null }> {
  return mix.map((m, i) => {
    const window = mix.slice(Math.max(0, i - targets.windowWeeks + 1), i + 1);
    return { week: m.week, score: driftSnapshot(m.week, window, targets, "")?.score ?? null };
  });
}

function Sparkline({ series, targets }: { series: Array<{ week: string; score: number | null }>; targets: AllocationTargets }) {
  const W = 220;
  const H = 56;
  const pad = 4;
  const max = Math.max(targets.thresholds.off * 1.25, ...series.map((s) => s.score ?? 0), 1);
  const x = (i: number) => (series.length <= 1 ? W / 2 : pad + (i * (W - 2 * pad)) / (series.length - 1));
  const y = (v: number) => H - pad - (v / max) * (H - 2 * pad);
  const pts = series.flatMap((s, i) => (s.score === null ? [] : [{ i, v: s.score, week: s.week }]));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-14 w-full max-w-[16rem] overflow-visible" role="img" aria-label={`Drift score by week: ${pts.map((p) => `${shortWeek(p.week)} ${p.v}`).join(", ")}`}>
      <line x1={0} x2={W} y1={y(targets.thresholds.watch)} y2={y(targets.thresholds.watch)} stroke="currentColor" strokeOpacity={0.25} strokeDasharray="3 3" />
      <line x1={0} x2={W} y1={y(targets.thresholds.off)} y2={y(targets.thresholds.off)} stroke="currentColor" strokeOpacity={0.45} strokeDasharray="3 3" />
      <text x={W} y={y(targets.thresholds.watch) - 2} textAnchor="end" className="fill-muted-foreground" fontSize={8}>watch {targets.thresholds.watch}</text>
      <text x={W} y={y(targets.thresholds.off) - 2} textAnchor="end" className="fill-muted-foreground" fontSize={8}>off {targets.thresholds.off}</text>
      <polyline fill="none" stroke="var(--rc-time-0)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" points={pts.map((p) => `${x(p.i)},${y(p.v)}`).join(" ")} />
      {pts.map((p) => (
        <circle key={p.week} cx={x(p.i)} cy={y(p.v)} r={3} fill="var(--rc-time-0)" stroke="var(--background, #fff)" strokeWidth={2}>
          <title>{`${p.week}: score ${p.v}`}</title>
        </circle>
      ))}
    </svg>
  );
}

export function DriftCard({ snapshot, mix, targets, areas }: { snapshot: DriftSnapshot | null; mix: readonly WeekMix[]; targets: AllocationTargets; areas: readonly AreaInfo[] }) {
  const label = (key: string) => areas.find((a) => a.key === key)?.label ?? key;
  return (
    <Card title="Drift" aside={METHOD_NOTE}>
      {snapshot === null ? (
        <p className="text-sm text-muted-foreground">No rated days yet in the last {targets.windowWeeks} weeks, so there is nothing to compare with the targets.</p>
      ) : (
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-3xl font-semibold tabular-nums leading-none">{snapshot.score}</span>
              <Pill tone={STATUS_TONE[snapshot.status]}>{STATUS_LABEL[snapshot.status]}</Pill>
              <span className="text-xs text-muted-foreground">points from target, last {snapshot.windowWeeks} weeks</span>
            </div>
            <ul className="space-y-0.5 text-sm">
              {snapshot.biggestUnder ? <li>{driftSentence(label(snapshot.biggestUnder), snapshot.perArea[snapshot.biggestUnder] ?? 0)}</li> : null}
              {snapshot.biggestOver ? <li>{driftSentence(label(snapshot.biggestOver), snapshot.perArea[snapshot.biggestOver] ?? 0)}</li> : null}
              {!snapshot.biggestUnder && !snapshot.biggestOver ? <li>Every area is on target.</li> : null}
            </ul>
          </div>
          <div className="rc-time">
            <div className="mb-0.5 text-[11px] text-muted-foreground">Score by week</div>
            <Sparkline series={scoreSeries(mix, targets)} targets={targets} />
          </div>
        </div>
      )}
    </Card>
  );
}
