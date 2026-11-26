import { cn } from "@/lib/utils";
import type { AreaSnapshot } from "../../lib/types";
import { DASHED, RATING_COLOR, RATING_LABEL } from "./helpers";
import { legendItems, type Lens } from "./lenses";

export function Legend({ lens, areas }: { lens: Lens; areas: readonly AreaSnapshot[] }) {
  const swatch = (key: string, style: { backgroundColor?: string }, className: string, label: string) => (
    <span key={key} className="inline-flex items-center gap-1.5">
      <span className={cn("size-3 rounded-sm", className)} style={style} />
      {label}
    </span>
  );
  const values =
    lens === "rating"
      ? [
          ...(["exceeds", "meets", "needs_improvement"] as const).map((r) => swatch(r, { backgroundColor: RATING_COLOR[r] }, "", RATING_LABEL[r])),
          <span key="changed" className="inline-flex items-center gap-1.5">
            <span className="relative size-3 rounded-sm bg-muted">
              <span className="absolute right-0 top-0 size-1.5 rounded-bl-sm bg-foreground ring-1 ring-background" />
            </span>
            You changed it
          </span>,
        ]
      : legendItems(lens, areas).map((item) => swatch(item.key, item.style, item.className, item.label));
  return (
    <div className="mt-3 space-y-1 text-[11px] text-muted-foreground">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {values}
        {lens === "area" ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="relative size-3 rounded-sm bg-muted">
              <span className="absolute left-1/2 top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-background ring-1 ring-foreground/70" />
            </span>
            More than one area
          </span>
        ) : null}
        {swatch("none", {}, "bg-muted", "No data")}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {swatch("provisional", { backgroundColor: RATING_COLOR.meets }, `opacity-50 ${DASHED}`, "Provisional")}
        {swatch("future", {}, "bg-transparent border border-dashed border-border", "Future")}
        <span className="inline-flex items-center gap-1.5">
          <span className="size-3 rounded-sm bg-muted ring-2 ring-foreground" />
          Today
        </span>
        <span>Hover or focus a day for its numbers.</span>
      </div>
    </div>
  );
}
