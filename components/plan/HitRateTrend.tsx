// The hit-rate trend: a small single-series SVG line. Values are labelled and in tooltips, never colour alone.
import type { PlanStats } from "../../lib/features/plan/logic";

const W = 360;
const H = 90;
const PAD = { l: 34, r: 8, t: 8, b: 18 };

export function HitRateTrend({ byWeek }: { byWeek: PlanStats["byWeek"] }) {
  const pts = byWeek.map((w, i) => ({ ...w, i }));
  const judged = pts.filter((p) => p.hitRate !== null);
  if (judged.length === 0) return <p className="text-sm text-muted-foreground">No judged weeks yet. Hit rate appears after a week is rated.</p>;
  const x = (i: number) => PAD.l + (pts.length <= 1 ? (W - PAD.l - PAD.r) / 2 : (i / (pts.length - 1)) * (W - PAD.l - PAD.r));
  const y = (v: number) => PAD.t + (1 - v) * (H - PAD.t - PAD.b);
  const path = judged.map((p, k) => `${k === 0 ? "M" : "L"}${x(p.i).toFixed(1)},${y(p.hitRate!).toFixed(1)}`).join(" ");
  const label = judged.map((p) => `${p.week}: ${Math.round(p.hitRate! * 100)}%`).join(", ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Plan hit rate by week. ${label}`} className="h-24 w-full max-w-md text-foreground">
      {[0, 0.5, 1].map((g) => (
        <g key={g}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(g)} y2={y(g)} className="stroke-border" strokeDasharray={g === 0.5 ? "3 3" : undefined} />
          <text x={PAD.l - 4} y={y(g) + 3} textAnchor="end" className="fill-muted-foreground text-[9px]">
            {Math.round(g * 100)}%
          </text>
        </g>
      ))}
      <path d={path} fill="none" className="stroke-primary" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {judged.map((p) => (
        <g key={p.week}>
          <circle cx={x(p.i)} cy={y(p.hitRate!)} r={4} className="fill-primary stroke-background" strokeWidth={2}>
            <title>{`${p.week}: ${Math.round(p.hitRate! * 100)}% hit rate`}</title>
          </circle>
        </g>
      ))}
      {pts.length > 0 ? (
        <>
          <text x={x(0)} y={H - 4} textAnchor="start" className="fill-muted-foreground text-[9px]">
            {pts[0]!.week.slice(5)}
          </text>
          <text x={x(pts.length - 1)} y={H - 4} textAnchor="end" className="fill-muted-foreground text-[9px]">
            {pts[pts.length - 1]!.week.slice(5)}
          </text>
        </>
      ) : null}
    </svg>
  );
}
