// Per-week actual mix against the target: one stacked bar per week, a target bar on top, a legend and a table view.
import type { AllocationTargets, WeekMix } from "../../lib/types";
import { MAX_SLOTS, OTHER_COLOR, shortWeek, slotColor, TIME_CSS, type AreaInfo } from "./helpers";

interface Seg {
  key: string;
  label: string;
  color: string;
  pct: number;
}

/** Areas past the 8th colour slot fold into one "Other" segment so colours never cycle. */
function segments(areas: readonly AreaInfo[], values: Record<string, number>, scale: number): Seg[] {
  const segs: Seg[] = areas.slice(0, MAX_SLOTS).map((a, i) => ({ key: a.key, label: a.label, color: slotColor(i), pct: (values[a.key] ?? 0) * scale }));
  const rest = areas.slice(MAX_SLOTS).reduce((s, a) => s + (values[a.key] ?? 0) * scale, 0);
  if (rest > 0) segs.push({ key: "other", label: "Other", color: OTHER_COLOR, pct: rest });
  return segs;
}

const fmt = (n: number): string => `${Math.round(n * 10) / 10}%`;

function Bar({ label, segs, note, empty }: { label: string; segs: Seg[]; note?: string; empty?: string }) {
  const total = segs.reduce((s, x) => s + x.pct, 0);
  return (
    <div className="grid grid-cols-[3.5rem_1fr] items-center gap-2" role="img" aria-label={`${label}: ${segs.filter((s) => s.pct > 0).map((s) => `${s.label} ${fmt(s.pct)}`).join(", ") || (empty ?? "no data")}`}>
      <span className="text-[11px] tabular-nums text-muted-foreground">{label}</span>
      {total <= 0 ? (
        <div className="h-5 rounded-sm border border-dashed border-border px-2 text-[11px] leading-5 text-muted-foreground">{empty ?? "no data"}</div>
      ) : (
        <div className="flex h-5 gap-0.5" title={note}>
          {segs.filter((s) => s.pct > 0).map((s) => (
            <div key={s.key} className="min-w-[2px] rounded-[3px]" style={{ flexGrow: s.pct, flexBasis: 0, backgroundColor: s.color }} title={`${s.label}: ${fmt(s.pct)}`} />
          ))}
        </div>
      )}
    </div>
  );
}

export function MixChart({ mix, targets, areas }: { mix: readonly WeekMix[]; targets: AllocationTargets; areas: readonly AreaInfo[] }) {
  const legend = segments(areas, {}, 1).map((s, i) => ({ ...s, target: i < MAX_SLOTS ? (targets.targets[s.key] ?? 0) : 0 }));
  const otherTarget = areas.slice(MAX_SLOTS).reduce((s, a) => s + (targets.targets[a.key] ?? 0), 0);
  return (
    <div className="rc-time space-y-3">
      <style>{TIME_CSS}</style>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground" aria-label="Legend">
        {legend.map((s) => (
          <li key={s.key} className="inline-flex items-center gap-1.5">
            <span className="size-3 rounded-sm" style={{ backgroundColor: s.color }} aria-hidden />
            {s.label} <span className="tabular-nums">(target {s.key === "other" ? otherTarget : s.target}%)</span>
          </li>
        ))}
      </ul>
      <div className="space-y-1.5">
        <Bar label="Target" segs={segments(areas, targets.targets, 1)} />
        <div className="border-t border-dashed border-border" aria-hidden />
        {mix.map((m) => (
          <Bar
            key={m.week}
            label={shortWeek(m.week)}
            segs={segments(areas, m.actual, 100)}
            empty="no rated days or scorecard"
            note={m.daysCounted > 0 ? `${m.daysCounted} rated days` : "scorecard only: no day areas this week"}
          />
        ))}
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">Show as table</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-max text-right tabular-nums">
            <thead>
              <tr className="text-muted-foreground">
                <th className="py-1 pr-3 text-left font-medium">Week</th>
                {areas.map((a) => (
                  <th key={a.key} className="px-2 py-1 font-medium">{a.label}</th>
                ))}
                <th className="px-2 py-1 font-medium">Days</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-border">
                <td className="py-1 pr-3 text-left">Target</td>
                {areas.map((a) => (
                  <td key={a.key} className="px-2 py-1">{fmt(targets.targets[a.key] ?? 0)}</td>
                ))}
                <td className="px-2 py-1" />
              </tr>
              {mix.map((m) => (
                <tr key={m.week} className="border-t border-border">
                  <td className="py-1 pr-3 text-left">{m.week}</td>
                  {areas.map((a) => (
                    <td key={a.key} className="px-2 py-1">{Object.keys(m.actual).length === 0 ? "–" : fmt((m.actual[a.key] ?? 0) * 100)}</td>
                  ))}
                  <td className="px-2 py-1">{m.daysCounted > 0 ? m.daysCounted : "score-card"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
