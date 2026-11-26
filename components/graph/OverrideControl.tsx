// Compact confirm / change control for a day, a week or a scorecard row. Confirm keeps the AI's value as reviewed;
// Change picks another value with an optional note. The AI's own record is never edited: the server stores the
// decision beside it, and `Clear` removes the decision again.
import { useContext, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { RpcContract } from "../../lib/contract";
import type { OverrideTarget } from "../../lib/types";
import { errorText, ErrorNote, Pill } from "../common";
import { RATING_LABEL } from "./helpers";
import { OverrideContext, RATING_OPTIONS, STATUS_LABEL, STATUS_OPTIONS } from "./overrideContext";

const labelOf = (target: OverrideTarget, value: string): string => (target.type === "scorecard" ? STATUS_LABEL[value] : (RATING_LABEL as Record<string, string>)[value]) ?? value;

export function OverrideControl({ target }: { target: OverrideTarget }) {
  const rpc = useRpc<RpcContract>();
  const { ai, override } = useContext(OverrideContext)(target);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (ai === null) return null;
  const options = target.type === "scorecard" ? STATUS_OPTIONS : RATING_OPTIONS;
  const current = override?.value ?? ai;

  const save = async (value: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await rpc.call("override.set", { target, value, note: note.trim() === "" ? null : note.trim() });
      setOpen(false);
      setNote("");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  const clear = async () => {
    setBusy(true);
    setError(null);
    try {
      await rpc.call("override.clear", { target });
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        {override?.decision === "confirmed" ? <Pill tone="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">You confirmed {labelOf(target, override.value)}</Pill> : null}
        {override?.decision === "overridden" ? <Pill>You set {labelOf(target, override.value)} · AI said {labelOf(target, override.aiValue)}</Pill> : null}
        {override?.aiChangedSince ? <Pill tone="bg-amber-500/15 text-amber-700 dark:text-amber-300">AI now says {labelOf(target, ai)} (re-rated since your review)</Pill> : null}
        {override?.note ? <span className="text-muted-foreground">“{override.note}”</span> : null}
        {override === null || override.aiChangedSince ? (
          <Button variant="outline" size="sm" className="h-6 px-2 text-xs" disabled={busy} aria-label={`Confirm ${labelOf(target, ai)}`} onClick={() => void save(null)}>
            <Icon name="Check" className="size-3" />
            Confirm {labelOf(target, ai)}
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={busy} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "Cancel" : "Change…"}
        </Button>
        {override ? (
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={busy} aria-label="Remove your decision" onClick={() => void clear()}>
            <Icon name="X" className="size-3" />
            Clear
          </Button>
        ) : null}
      </div>
      {open ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {options.map((value) => (
            <Button
              key={value}
              variant={value === current ? "default" : "outline"}
              size="sm"
              className={cn("h-6 px-2 text-xs")}
              disabled={busy}
              onClick={() => void save(value)}
            >
              {labelOf(target, value)}
            </Button>
          ))}
          <input
            value={note}
            maxLength={300}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Why? (optional note, used to calibrate future ratings)"
            aria-label="Note for this decision"
            className="h-6 min-w-48 flex-1 rounded-md border border-border bg-background px-2 text-xs"
          />
        </div>
      ) : null}
      <ErrorNote message={error} />
    </div>
  );
}
