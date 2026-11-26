import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { GridV2, GridWeek } from "../../lib/types";
import { cellTitle, RATING_COLOR, WEEKDAYS } from "./helpers";
import { cellLook, type Lens, type LensCtx } from "./lenses";
import { DRIFT_COLOR, SEVERITY_COLOR, weekMarkerItems } from "./markers";
import { anchorOf, TIP_ID, TipPopover, type TipState } from "./TipPopover";
import { cellTip, weekTip } from "./tooltip";

export type Selection = { type: "day"; date: string } | { type: "week"; week: string } | null;

function WeekMarkers({ week }: { week: GridWeek }) {
  const items = weekMarkerItems(week.markers);
  return (
    <span className="flex h-3 items-center justify-center gap-0.5 text-[9px] leading-3" aria-hidden="true">
      {items.guardrail ? (
        <span className="inline-flex items-center gap-px">
          <span
            className="size-2 rounded-full"
            style={items.guardrail.severity === "info" ? { boxShadow: `inset 0 0 0 1.5px ${SEVERITY_COLOR.info}` } : { backgroundColor: SEVERITY_COLOR[items.guardrail.severity] }}
          />
          <span className="text-muted-foreground">{items.guardrail.count}</span>
        </span>
      ) : null}
      {items.drift ? <span style={{ color: DRIFT_COLOR[items.drift] }}>{items.drift === "off" ? "▲" : "△"}</span> : null}
      {items.badge ? (
        <span className="text-muted-foreground">
          {items.badge.shipped > 0 ? `✓${items.badge.shipped}` : ""}
          {items.badge.needClosure > 0 ? `!${items.badge.needClosure}` : ""}
        </span>
      ) : null}
    </span>
  );
}

export function Grid({ grid, lens, selection, onSelect }: { grid: GridV2; lens: Lens; selection: Selection; onSelect: (s: Selection) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<TipState | null>(null);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, []);
  const ctx = useMemo<LensCtx>(() => ({ areas: grid.areas, workdayHours: grid.workdayHours, today: grid.today }), [grid.areas, grid.workdayHours, grid.today]);
  const hide = useCallback(() => setTip(null), []);
  const show = (id: string, el: Element, content: TipState["content"]) => setTip({ id, anchor: anchorOf(el), content });
  const tipProps = (id: string, content: () => TipState["content"]) => ({
    "aria-describedby": tip?.id === id ? TIP_ID : undefined,
    onMouseEnter: (event: { currentTarget: Element }) => show(id, event.currentTarget, content()),
    onFocus: (event: { currentTarget: Element }) => show(id, event.currentTarget, content()),
    onMouseLeave: hide,
    onBlur: hide,
    onKeyDown: (event: { key: string }) => {
      if (event.key === "Escape") hide();
    },
  });
  return (
    <div ref={scroller} onScroll={hide} className="overflow-x-auto pb-1">
      <TipPopover tip={tip} />
      <div className="inline-flex gap-1">
        <div className="flex flex-col gap-1 pr-1 pt-[3.75rem] text-[10px] leading-4 text-muted-foreground">
          {WEEKDAYS.map((d) => (
            <span key={d} className="h-4">
              {d}
            </span>
          ))}
        </div>
        {grid.weeks.map((week: GridWeek) => {
          const selected = selection?.type === "week" && selection.week === week.week;
          return (
            <div key={week.week} className="flex flex-col items-center gap-1">
              <span className="h-4 w-6 whitespace-nowrap text-[10px] leading-4 text-muted-foreground">{week.monthLabel ?? ""}</span>
              <WeekMarkers week={week} />
              <button
                type="button"
                aria-label={`Open report for ${week.week}${week.final ? "" : " (not final)"}`}
                onClick={() => onSelect({ type: "week", week: week.week })}
                {...tipProps(week.week, () => weekTip(week))}
                className={cn(
                  "h-5 w-6 rounded text-[10px] font-medium tabular-nums transition-colors hover:bg-muted",
                  selected ? "bg-foreground text-background hover:bg-foreground" : week.week === grid.currentWeek ? "text-foreground" : "text-muted-foreground",
                )}
                style={week.final && week.rating && week.rating !== "none" && !selected ? { boxShadow: `inset 0 -2px 0 ${RATING_COLOR[week.rating]}` } : undefined}
              >
                {week.label}
              </button>
              {week.cells.map((cell) => {
                const look = cellLook(lens, cell, ctx);
                const isSelected = selection?.type === "day" && selection.date === cell.date;
                return (
                  <button
                    key={cell.date}
                    type="button"
                    disabled={cell.state === "future"}
                    aria-label={cellTitle(cell)}
                    onClick={() => onSelect({ type: "day", date: cell.date })}
                    {...tipProps(cell.date, () => cellTip(cell, ctx))}
                    className={cn(
                      "relative size-4 rounded-sm",
                      look.className,
                      cell.date === grid.today && "ring-2 ring-foreground ring-offset-1 ring-offset-background",
                      isSelected && "ring-2 ring-blue-500",
                    )}
                    style={look.style}
                  >
                    {look.glyph === "corner" ? <span className="absolute right-0 top-0 size-1.5 rounded-bl-sm bg-foreground ring-1 ring-background" /> : null}
                    {look.glyph === "dot" ? <span className="absolute left-1/2 top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-background ring-1 ring-foreground/70" /> : null}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
