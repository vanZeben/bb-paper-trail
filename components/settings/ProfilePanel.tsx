// Profile & setup: identity and handles, the role card ("Replace role card → re-run setup"), and the facts the agent
// inferred, each with its basis. Saves through setup.answer; replacing the card re-runs the synthesis.
import { useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { RpcContract } from "../../lib/contract";
import type { Profile, RoleCard } from "../../lib/types";
import { errorText, ErrorNote, useAsync } from "../common";
import { RoleCardInput } from "../onboarding/RoleCardInput";
import { progressLine, useSetupRun } from "../onboarding/useSetupRun";

const FIELD = "h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const EMPTY = { level: null, scope: null, managerName: null, reviewCadence: null, basis: {} } as const;

interface Draft {
  name: string;
  email: string;
  handles: Array<{ key: string; value: string }>;
  level: string;
  scope: string;
  managerName: string;
  reviewCadence: string;
}

const toDraft = (p: Profile | null): Draft => ({
  name: p?.identity.name ?? "",
  email: p?.identity.email ?? "",
  handles: Object.entries(p?.identity.handles ?? {}).map(([key, value]) => ({ key, value })),
  level: p?.inferred.level ?? "",
  scope: p?.inferred.scope ?? "",
  managerName: p?.inferred.managerName ?? "",
  reviewCadence: p?.inferred.reviewCadence ?? "",
});
const orNull = (v: string) => (v.trim() === "" ? null : v.trim());

function buildProfile(base: Profile | null, d: Draft, roleCard: RoleCard | null): Profile {
  const handles: Record<string, string> = {};
  for (const h of d.handles) if (h.key.trim() !== "" && h.value.trim() !== "") handles[h.key.trim().toLowerCase()] = h.value.trim();
  const inferred = base?.inferred ?? { ...EMPTY, basis: {} };
  return {
    version: 1,
    identity: { name: d.name.trim(), email: orNull(d.email), handles },
    roleCard,
    inferred: { ...inferred, level: orNull(d.level), scope: orNull(d.scope), managerName: orNull(d.managerName), reviewCadence: orNull(d.reviewCadence) },
    setupAt: base?.setupAt ?? null,
  };
}

function Fact({ label, value, onChange, basis, wide }: { label: string; value: string; onChange: (v: string) => void; basis: string | undefined; wide?: boolean }) {
  return (
    <label className={`space-y-0.5 text-sm ${wide ? "sm:col-span-2" : ""}`}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} className={FIELD} placeholder="Not found" />
      {basis ? <span className="block text-[11px] text-muted-foreground">Basis: {basis}</span> : null}
    </label>
  );
}

export function ProfilePanel() {
  const rpc = useRpc<RpcContract>();
  const data = useAsync(() => rpc.call("setup.get"), []);
  const profile = data.data?.profile ?? null;
  const sig = useMemo(() => JSON.stringify(profile), [profile]);
  const [draft, setDraft] = useState<Draft>(() => toDraft(profile));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [card, setCard] = useState<RoleCard | null>(null);
  const [cardProblem, setCardProblem] = useState<string | null>(null);
  const run = useSetupRun();

  // Follow the server until the user edits.
  useEffect(() => {
    if (!dirty) setDraft(toDraft(profile));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  useEffect(() => {
    if (run.phase === "applied") {
      setReplacing(false);
      data.reload();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.phase]);

  const patch = (change: Partial<Draft>) => {
    setDirty(true);
    setSaved(false);
    setDraft((d) => ({ ...d, ...change }));
  };
  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      await rpc.call("setup.answer", { profile: buildProfile(profile, draft, profile?.roleCard ?? null) });
      setDirty(false);
      setSaved(true);
      data.reload();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };
  const rerun = () => {
    if (card === null) return;
    setDirty(false);
    void run.start(buildProfile(profile, draft, card));
  };

  const inf = profile?.inferred;
  const basis = inf?.basis ?? {};
  const roleCard = profile?.roleCard ?? null;
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h4 className="text-xs font-semibold text-muted-foreground">You</h4>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="space-y-0.5 text-sm">
            <span className="text-xs font-medium text-muted-foreground">Name</span>
            <input value={draft.name} onChange={(e) => patch({ name: e.target.value })} className={FIELD} autoComplete="name" />
          </label>
          <label className="space-y-0.5 text-sm">
            <span className="text-xs font-medium text-muted-foreground">Email</span>
            <input value={draft.email} onChange={(e) => patch({ email: e.target.value })} className={FIELD} autoComplete="email" inputMode="email" />
          </label>
        </div>
        <div className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Handles (how you appear in each tool)</span>
          {draft.handles.map((h, i) => (
            <div key={i} className="flex items-center gap-2">
              <input value={h.key} onChange={(e) => patch({ handles: draft.handles.map((x, at) => (at === i ? { ...x, key: e.target.value } : x)) })} aria-label="Tool" placeholder="slack" className={`${FIELD} max-w-32`} />
              <input value={h.value} onChange={(e) => patch({ handles: draft.handles.map((x, at) => (at === i ? { ...x, value: e.target.value } : x)) })} aria-label="Handle" placeholder="handle or id" className={FIELD} />
              <Button variant="ghost" size="sm" aria-label="Remove handle" onClick={() => patch({ handles: draft.handles.filter((_, at) => at !== i) })}>
                <Icon name="X" className="size-3.5" />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={() => patch({ handles: [...draft.handles, { key: "", value: "" }] })}>
            <Icon name="Plus" className="size-3.5" />Add handle
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <h4 className="text-xs font-semibold text-muted-foreground">What the agent inferred</h4>
        {inf && profile?.setupAt ? null : <p className="text-xs text-muted-foreground">Nothing inferred yet. Replace the role card below to run setup.</p>}
        <div className="grid gap-2 sm:grid-cols-2">
          <Fact label="Level" value={draft.level} onChange={(v) => patch({ level: v })} basis={basis.level} />
          <Fact label="Manager (first name)" value={draft.managerName} onChange={(v) => patch({ managerName: v })} basis={basis.managerName} />
          <Fact label="Scope" value={draft.scope} onChange={(v) => patch({ scope: v })} basis={basis.scope} wide />
          <Fact label="Review cadence" value={draft.reviewCadence} onChange={(v) => patch({ reviewCadence: v })} basis={basis.reviewCadence} wide />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={saving || !dirty || draft.name.trim() === ""} onClick={() => void save()}>
          <Icon name={saving ? "Loader" : "Check"} className="size-3.5" />Save
        </Button>
        {saved ? <span className="text-xs text-muted-foreground">Saved.</span> : null}
      </div>

      <div className="space-y-2 border-t border-border pt-3">
        <h4 className="text-xs font-semibold text-muted-foreground">Role card</h4>
        {roleCard ? (
          <p className="text-sm">
            {roleCard.kind === "text" ? (roleCard.title ? `Text from ${roleCard.title}` : "Pasted text") : roleCard.kind === "note" ? "Note" : "Link"}
            <span className="ml-2 break-all text-xs text-muted-foreground">{roleCard.kind === "text" ? `${roleCard.value.length.toLocaleString("en-US")} characters` : roleCard.value}</span>
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">No role card yet.</p>
        )}
        {replacing ? (
          <div className="space-y-2">
            <RoleCardInput onChange={(c, problem) => { setCard(c); setCardProblem(problem); }} />
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={card === null || cardProblem !== null || draft.name.trim() === "" || run.phase === "running"} onClick={rerun}>
                <Icon name={run.phase === "running" ? "Loader" : "RefreshCw"} className="size-3.5" />Save and re-run setup
              </Button>
              <Button variant="ghost" size="sm" disabled={run.phase === "running"} onClick={() => setReplacing(false)}>Cancel</Button>
              {run.phase === "running" ? (
                <span role="status" aria-live="polite" className="text-xs text-muted-foreground">{progressLine(run.seconds)} ({run.seconds}s)</span>
              ) : null}
            </div>
            <p className="text-[11px] text-muted-foreground">Re-running replaces only what the agent set. Anything you have edited since (the facts above, areas, work split, guardrails) and every goal you wrote or changed is kept, and the summary afterwards lists what was kept. Area keys stay the same where the role card still has the area, so your history lines up.</p>
          </div>
        ) : (
          <Button variant="outline" size="sm" onClick={() => { run.phase !== "running" && setReplacing(true); }}>
            <Icon name="RefreshCw" className="size-3.5" />Replace role card → re-run setup
          </Button>
        )}
        {run.phase === "applied" && run.note ? <p className="text-xs text-muted-foreground">{run.note}</p> : null}
        <ErrorNote message={run.phase === "failed" ? `Setup did not finish: ${run.error ?? "unknown error"}` : null} />
      </div>
      <ErrorNote message={error ?? data.error} />
    </div>
  );
}
