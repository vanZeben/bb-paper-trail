// A hover/focus popover for grid cells and week headers. Fixed-position so the grid's horizontal scroller never clips
// it; it is a description of the button that opened it (aria-describedby), not a menu.
import type { TipContent } from "./tooltip";
import { PLUGIN_ID } from "../../lib/meta";

export interface TipState {
  id: string;
  anchor: { left: number; right: number; top: number; bottom: number };
  content: TipContent;
}

export const TIP_ID = `${PLUGIN_ID}-graph-tip`;
const WIDTH = 264;

export function anchorOf(el: Element): TipState["anchor"] {
  const r = el.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
}

export function TipPopover({ tip }: { tip: TipState | null }) {
  if (tip === null) return null;
  const vw = typeof window === "undefined" ? 1024 : window.innerWidth;
  const center = (tip.anchor.left + tip.anchor.right) / 2;
  const left = Math.min(Math.max(center - WIDTH / 2, 8), Math.max(8, vw - WIDTH - 8));
  const below = tip.anchor.top < 180;
  const style = below ? { left, top: tip.anchor.bottom + 6, width: WIDTH } : { left, bottom: (typeof window === "undefined" ? 0 : window.innerHeight) - tip.anchor.top + 6, width: WIDTH };
  return (
    <div id={TIP_ID} role="tooltip" style={style} className="pointer-events-none fixed z-50 rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <p className="mb-1 font-semibold">{tip.content.title}</p>
      <dl className="space-y-0.5">
        {tip.content.rows.map((row) => (
          <div key={row.label} className="flex gap-2">
            <dt className="w-16 shrink-0 text-muted-foreground">{row.label}</dt>
            <dd className="min-w-0 flex-1 break-words">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
