import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { RpcContract } from "../../lib/contract";
import type { RoleFramework } from "../../lib/types";
import { errorText, ErrorNote, Pill, useAsync } from "../common";

type Area = RoleFramework["areas"][number];
const FIELD = "w-full rounded-md border border-border bg-background px-2 py-1 text-sm";
const KINDS: Array<{ id: Area["kind"]; label: string }> = [
  { id: "leverage", label: "Leverage" },
  { id: "hands_on", label: "Hands-on" },
  { id: "other", label: "Other" },
];
const SLUG = /^[a-z][a-z0-9_]{1,31}$/;
const slugOf = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);

/** Role framework: presets, an editor and the import-from-role-doc flow. Used in Settings and in onboarding. */
export function FrameworkPanel({ onSaved }: { onSaved?: () => void }) {
  const rpc = useRpc<RpcContract>();
  const data = useAsync(() => rpc.call("framework.get"), []);
  const proposal = useAsync(() => rpc.call("framework.proposal"), []);
  const [draft, setDraft] = useState<RoleFramework | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [importKind, setImportKind] = useState<"text" | "url" | "note">("text");
  const [importValue, setImportValue] = useState("");
  const server = data.data?.framework ?? null;

  // Follow the server until the user edits.
  useEffect(() => {
    if (server !== null && !dirty(draft, server)) setDraft(server);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server]);
  const edited = draft !== null && server !== null && dirty(draft, server);

  const act = async (run: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await run();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  const patch = (change: Partial<RoleFramework>) => {
    setSaved(false);
    setDraft((d) => (d === null ? d : { ...d, ...change }));
  };
  const patchArea = (i: number, change: Partial<Area>) => patch({ areas: draft!.areas.map((a, at) => (at === i ? { ...a, ...change } : a)) });
  const move = (i: number, by: number) => {
    const areas = [...draft!.areas];
    const [item] = areas.splice(i, 1);
    areas.splice(i + by, 0, item!);
    patch({ areas });
  };

  if (draft === null) return <ErrorNote message={data.error} />;
  const keys = draft.areas.map((a) => a.key);
  const keyProblem = (a: Area) => (!SLUG.test(a.key) ? "lowercase letters, digits, underscores; 2-32 characters" : keys.filter((k) => k === a.key).length > 1 ? "duplicate key" : null);
  const problem = draft.areas.length < 2 ? "At least 2 areas." : draft.areas.length > 10 ? "At most 10 areas." : draft.areas.some(keyProblem) ? "Fix the area keys." : null;
  const p = proposal.data;

  return (
    <div className="space-y-4">
      <ErrorNote message={error ?? data.error} />

      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-muted-foreground" htmlFor="fw-preset">Start from a preset</label>
        <select id="fw-preset" className={`${FIELD} w-auto`} defaultValue="" onChange={(e) => { const id = e.target.value; e.target.value = ""; if (id) void act(async () => { await rpc.call("framework.usePreset", { id }); setSaved(true); onSaved?.(); }); }}>
          <option value="">Choose…</option>
          {data.data?.presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
        </select>
        <span className="text-xs text-muted-foreground">Replaces the areas and rubric; your name and pronoun stay.</span>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        <label className="space-y-1 text-xs text-muted-foreground">Framework name
          <input className={FIELD} value={draft.name} maxLength={80} onChange={(e) => patch({ name: e.target.value })} />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">Your name in the ratings
          <input className={FIELD} value={draft.subject.name} maxLength={60} onChange={(e) => patch({ subject: { ...draft.subject, name: e.target.value } })} />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">Pronoun
          <select className={FIELD} value={draft.subject.pronoun} onChange={(e) => patch({ subject: { ...draft.subject, pronoun: e.target.value as RoleFramework["subject"]["pronoun"] } })}>
            <option value="they">they</option><option value="he">he</option><option value="she">she</option>
          </select>
        </label>
      </div>

      <div className="space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Areas ({draft.areas.length} of 2 to 10)</h4>
        {draft.areas.map((area, i) => (
          <div key={i} className="space-y-1.5 rounded-lg border border-border p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <input aria-label={`Area ${i + 1} label`} placeholder="Label" className={`${FIELD} min-w-32 flex-1`} value={area.label} maxLength={80}
                onChange={(e) => patchArea(i, { label: e.target.value, ...(area.key === "" || area.key === slugOf(area.label) ? { key: slugOf(e.target.value) } : {}) })} />
              <input aria-label={`Area ${i + 1} key`} placeholder="key" className={`${FIELD} w-40 font-mono text-xs`} value={area.key} maxLength={32} onChange={(e) => patchArea(i, { key: e.target.value })} />
              <select aria-label={`Area ${i + 1} kind`} className={`${FIELD} w-auto`} value={area.kind} onChange={(e) => patchArea(i, { kind: e.target.value as Area["kind"] })}>
                {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
              </select>
              <Button variant="ghost" size="icon" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><Icon name="ArrowUp" className="size-3.5" /></Button>
              <Button variant="ghost" size="icon" aria-label="Move down" disabled={i === draft.areas.length - 1} onClick={() => move(i, 1)}><Icon name="ArrowDown" className="size-3.5" /></Button>
              <Button variant="ghost" size="icon" aria-label="Remove area" disabled={draft.areas.length <= 2} onClick={() => patch({ areas: draft.areas.filter((_, at) => at !== i) })}><Icon name="Trash2" className="size-3.5" /></Button>
            </div>
            <textarea aria-label={`Area ${i + 1} description`} rows={2} className={FIELD} placeholder="What counts as evidence in this area" value={area.description} maxLength={400} onChange={(e) => patchArea(i, { description: e.target.value })} />
            {keyProblem(area) ? <p className="text-xs text-destructive">Key: {keyProblem(area)}</p> : null}
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" disabled={draft.areas.length >= 10} onClick={() => patch({ areas: [...draft.areas, { key: "", label: "", description: "", kind: "other" }] })}>
            <Icon name="Plus" className="size-3.5" />Add area
          </Button>
          <span className="text-xs text-muted-foreground">Renaming a key keeps old weeks readable (the old key is remembered as an alias).</span>
        </div>
      </div>

      <details className="rounded-lg border border-border p-2.5">
        <summary className="cursor-pointer text-sm font-medium">Rating rubric and role document</summary>
        <div className="mt-2 space-y-2">
          {([["bar", "The bar (a normal day)"], ["exceeds", "Exceeds"], ["meets", "Meets"], ["needsImprovement", "Needs improvement"]] as const).map(([key, label]) => (
            <label key={key} className="block space-y-1 text-xs text-muted-foreground">{label}
              <textarea rows={3} className={FIELD} value={draft.rubric[key]} maxLength={key === "bar" ? 300 : 800} onChange={(e) => patch({ rubric: { ...draft.rubric, [key]: e.target.value } })} />
            </label>
          ))}
          <label className="block space-y-1 text-xs text-muted-foreground">Extra rules (one per line)
            <textarea rows={3} className={FIELD} value={draft.rubric.extraRules.join("\n")} onChange={(e) => patch({ rubric: { ...draft.rubric, extraRules: e.target.value.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 12) } })} />
          </label>
          <label className="block space-y-1 text-xs text-muted-foreground">Role document (the standard the agent rates against, up to 6000 characters)
            <textarea rows={5} className={FIELD} value={draft.roleDoc} maxLength={6000} onChange={(e) => patch({ roleDoc: e.target.value })} />
          </label>
        </div>
      </details>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy || !edited || problem !== null} onClick={() => void act(async () => { await rpc.call("framework.set", { framework: draft }); setSaved(true); onSaved?.(); })}>
          <Icon name={busy ? "Loader" : "Save"} className="size-3.5" />Save framework
        </Button>
        <Button variant="ghost" size="sm" disabled={!edited} onClick={() => { setDraft(server); setSaved(false); }}>Discard changes</Button>
        {problem !== null ? <span className="text-xs text-destructive">{problem}</span> : null}
        {saved && !edited ? <span className="text-xs text-muted-foreground">Saved.</span> : null}
      </div>

      <div className="space-y-2 rounded-lg border border-border p-2.5">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Import from a role document</h4>
        <p className="text-xs text-muted-foreground">An agent reads the document and proposes areas and a rubric. Nothing changes until you load the proposal into the editor and save.</p>
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Document type" className={`${FIELD} w-auto`} value={importKind} onChange={(e) => setImportKind(e.target.value as typeof importKind)}>
            <option value="text">Paste text</option><option value="url">URL</option><option value="note">Note name</option>
          </select>
          {importKind === "text" ? null : <input aria-label="Document reference" className={`${FIELD} min-w-48 flex-1`} placeholder={importKind === "url" ? "https://…" : "Role description"} value={importValue} onChange={(e) => setImportValue(e.target.value)} />}
        </div>
        {importKind === "text" ? <textarea aria-label="Role document text" rows={5} className={FIELD} placeholder="Paste the role description or level expectations" value={importValue} maxLength={20000} onChange={(e) => setImportValue(e.target.value)} /> : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" disabled={busy || importValue.trim() === "" || p?.status === "running"} onClick={() => void act(async () => { await rpc.call("framework.importDoc", { ref: { kind: importKind, value: importValue } }); proposal.reload(); })}>
            <Icon name={p?.status === "running" ? "Loader" : "Sparkles"} className="size-3.5" />Propose a framework
          </Button>
          {p?.status === "running" ? <Pill tone="bg-blue-500/15 text-blue-700 dark:text-blue-300">reading {p.sourceRef}…</Pill> : null}
        </div>
        {p?.status === "failed" ? <ErrorNote message={`Import failed: ${p.error ?? "unknown error"}`} /> : null}
        {p?.status === "ready" && p.framework !== null ? (
          <div className="space-y-1.5 rounded-md bg-muted/50 p-2.5 text-sm">
            <div className="font-medium">Proposal from {p.sourceRef}: {p.framework.name}</div>
            <ul className="list-inside list-disc text-xs text-muted-foreground">
              {p.framework.areas.map((a) => <li key={a.key}><span className="font-medium text-foreground">{a.label}</span> ({a.kind.replace("_", "-")}): {a.description}</li>)}
            </ul>
            <Button variant="outline" size="sm" onClick={() => { setDraft({ ...p.framework!, subject: draft.subject, managerName: draft.managerName }); setSaved(false); }}>
              <Icon name="Download" className="size-3.5" />Load into the editor
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Whether the draft differs from what the server holds (updatedAt is ignored). */
function dirty(draft: RoleFramework | null, server: RoleFramework): boolean {
  if (draft === null) return false;
  return JSON.stringify({ ...draft, updatedAt: "" }) !== JSON.stringify({ ...server, updatedAt: "" });
}
