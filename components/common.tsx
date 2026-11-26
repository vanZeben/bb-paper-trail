import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { useRealtime } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { CHANNEL } from "../lib/meta";

export interface Async<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Load data on mount and whenever `deps` change; reload when the server announces on the plugin's realtime channel
 * that stored state or the run queue moved. A reload keeps the previous data on screen, so live updates never flash
 * the page back to a loading state.
 */
export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[]): Async<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  });
  const loadRef = useRef(load);
  loadRef.current = load;
  const generation = useRef(0);

  const reload = useCallback(() => {
    const mine = ++generation.current;
    loadRef.current().then(
      (data) => {
        if (mine === generation.current) setState({ data, error: null, loading: false });
      },
      (cause: unknown) => {
        if (mine === generation.current) {
          setState((previous) => ({ data: previous.data, error: errorText(cause), loading: false }));
        }
      },
    );
  }, []);

  useEffect(() => {
    setState((previous) => ({ ...previous, loading: true }));
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useRealtime(CHANNEL, reload);
  return { ...state, reload };
}

export const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (iso == null || iso === "") return "never";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const seconds = Math.round((now - at) / 1000);
  const abs = Math.abs(seconds);
  const unit =
    abs < 90 ? "just now" : abs < 5400 ? `${Math.round(abs / 60)}m` : abs < 129600 ? `${Math.round(abs / 3600)}h` : `${Math.round(abs / 86400)}d`;
  if (unit === "just now") return unit;
  return seconds >= 0 ? `${unit} ago` : `in ${unit}`;
}

export function Pill({ children, tone, className }: { children: ReactNode; tone?: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center truncate rounded-full px-2 py-0.5 text-[11px] font-medium leading-4",
        tone ?? "bg-muted text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function StatTile({
  label,
  value,
  hint,
  icon,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: string;
  tone?: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-card px-3.5 py-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon === undefined ? null : <Icon name={icon} className="size-3.5" />}
        <span className="truncate">{label}</span>
      </div>
      <div className={cn("mt-1 text-2xl font-semibold tabular-nums leading-none", tone)}>{value}</div>
      {hint === undefined ? null : <div className="mt-1.5 truncate text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { id: T; label: string; icon?: string }[];
  onChange: (next: T) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex max-w-full gap-0.5 overflow-x-auto rounded-lg border border-border bg-muted/50 p-0.5">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="tab"
          aria-selected={option.id === value}
          onClick={() => onChange(option.id)}
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            option.id === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.icon === undefined ? null : <Icon name={option.icon} className="size-3.5" />}
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {message}
    </p>
  );
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</h3>
      {aside}
    </div>
  );
}

export function Card({ title, aside, children, className }: { title: string; aside?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("min-w-0 rounded-lg border border-border bg-card p-3.5", className)}>
      <SectionTitle>{title}</SectionTitle>
      {aside ? <p className="-mt-1.5 mb-2.5 text-[11px] leading-snug text-muted-foreground">{aside}</p> : null}
      {children}
    </section>
  );
}

/** Props that make a non-button element (a card row) behave as one: click, Enter and Space. */
export function activate(run: () => void) {
  return {
    role: "button" as const,
    tabIndex: 0,
    onClick: run,
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      run();
    },
  };
}

export const CARD_HOVER = "cursor-pointer transition-colors hover:bg-muted/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring";
