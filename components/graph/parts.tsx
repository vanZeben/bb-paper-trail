// Small presentational pieces shared by the day and week panels.
import { Icon } from "@/components/ui/icon";
import type { Coverage as CoverageEntry, EvidenceEntry, Rating } from "../../lib/types";
import { Pill } from "../common";
import { safeHref } from "../safeHref";
import { coverageGlyph, RATING_LABEL } from "./helpers";

export const ratingTone: Record<Rating, string> = {
  exceeds: "bg-lime-400/30 text-lime-800 dark:text-lime-300",
  meets: "bg-green-700/20 text-green-800 dark:text-green-300",
  needs_improvement: "bg-orange-500/20 text-orange-800 dark:text-orange-300",
  none: "bg-muted text-muted-foreground",
};

export function RatingPill({ rating, provisional }: { rating: Rating; provisional?: boolean }) {
  return (
    <>
      <Pill tone={ratingTone[rating]}>{RATING_LABEL[rating]}</Pill>
      {provisional ? <Pill>provisional</Pill> : null}
    </>
  );
}

/** Per-source capture status. `off` sources are shown dimmed and never flagged as a problem. */
export function CoverageLine({ coverage }: { coverage: Record<string, CoverageEntry> }) {
  return (
    <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
      {Object.keys(coverage).map((source) => {
        const c = coverage[source]!;
        const problem = c.status === "partial" || c.status === "failed";
        return (
          <span key={source} className={problem ? "text-amber-700 dark:text-amber-300" : c.status === "off" ? "opacity-60" : undefined} title={c.note ?? undefined}>
            {source} {coverageGlyph(c.status)}
            {problem && c.note ? ` ${c.note}` : ""}
          </span>
        );
      })}
    </p>
  );
}

export function EvidenceId({ id }: { id: string }) {
  return <span className="rounded bg-muted px-1.5 font-mono text-[11px] text-muted-foreground">{id}</span>;
}

export function EvidenceRow({ entry }: { entry: EvidenceEntry }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      <span className="mt-0.5 shrink-0 rounded bg-muted px-1.5 font-mono text-[11px] text-muted-foreground">{entry.id}</span>
      <span className="min-w-0 flex-1">
        <span className="text-muted-foreground">{entry.source} · </span>
        {entry.what}
        {entry.outcome ? <span className="text-muted-foreground"> → {entry.outcome}</span> : null}
      </span>
      {entry.link ? (
        <a href={safeHref(entry.link)} target="_blank" rel="noreferrer" aria-label="Open source" className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground">
          <Icon name="ExternalLink" className="size-3.5" />
        </a>
      ) : null}
    </li>
  );
}
