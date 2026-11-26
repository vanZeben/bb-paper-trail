// The closure note: expected vs realised outcome for a shipped thread.
import { useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { RpcContract } from "../../lib/contract";
import type { ClosureNote, Thread } from "../../lib/types";
import { errorText, ErrorNote, Segmented } from "../common";

export const OUTCOMES = [
  { id: "better", label: "Better than expected" },
  { id: "as_expected", label: "As expected" },
  { id: "mixed", label: "Mixed" },
  { id: "worse", label: "Worse than expected" },
] as const;

const area = "w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm";

export function ClosureDialog({ thread, existing, onClose, onSaved }: { thread: Thread; existing?: ClosureNote | undefined; onClose: () => void; onSaved: () => void }) {
  const rpc = useRpc<RpcContract>();
  const [outcome, setOutcome] = useState<ClosureNote["outcome"]>(existing?.outcome ?? "as_expected");
  const [expectation, setExpectation] = useState(existing?.expectation ?? "");
  const [result, setResult] = useState(existing?.result ?? "");
  const [learnings, setLearnings] = useState(existing?.learnings ?? "");
  const [impact, setImpact] = useState(existing?.impact ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      setError(null);
      await rpc.call("closure.set", { threadId: thread.id, outcome, expectation, result, learnings, ...(impact.trim() ? { impact: impact.trim() } : {}) });
      onSaved();
      onClose();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Close out: {thread.title}</DialogTitle>
          <DialogDescription>A few lines now are worth a lot at review time.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <Segmented label="Outcome" value={outcome} options={OUTCOMES} onChange={setOutcome} />
          <label className="block space-y-1">
            <span className="font-medium">What did you expect?</span>
            <textarea className={area} rows={2} maxLength={400} value={expectation} onChange={(e) => setExpectation(e.target.value)} />
          </label>
          <label className="block space-y-1">
            <span className="font-medium">What happened?</span>
            <textarea className={area} rows={2} maxLength={400} value={result} onChange={(e) => setResult(e.target.value)} />
          </label>
          <label className="block space-y-1">
            <span className="font-medium">What did you learn?</span>
            <textarea className={area} rows={3} maxLength={800} value={learnings} onChange={(e) => setLearnings(e.target.value)} />
          </label>
          <label className="block space-y-1">
            <span className="font-medium">Impact (optional)</span>
            <input className={area} maxLength={200} value={impact} onChange={(e) => setImpact(e.target.value)} placeholder="e.g. cut p95 latency by 30%" />
          </label>
          <ErrorNote message={error} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={saving || expectation.trim() === "" || result.trim() === ""} onClick={() => void save()}>
            Save note
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
