import { cn } from "@/lib/utils";
import { LENSES, lensDisabledNote, type Lens, type LensAvailability } from "./lenses";

/** Lens buttons. An unavailable lens stays visible but disabled, with the reason in its title and next to it. */
export function LensPicker({ lens, availability, onChange }: { lens: Lens; availability: LensAvailability; onChange: (next: Lens) => void }) {
  return (
    <div role="radiogroup" aria-label="Graph lens" className="inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-lg border border-border bg-muted/50 p-0.5">
      {LENSES.map((item) => {
        const note = lensDisabledNote(item.id, availability);
        const active = item.id === lens;
        return (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={note !== null}
            title={note ?? item.hint}
            onClick={() => onChange(item.id)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
              active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {item.label}
            {note !== null ? <span className="text-[10px] font-normal">{note}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
