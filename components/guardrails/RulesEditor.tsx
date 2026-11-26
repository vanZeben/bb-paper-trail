import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { RpcContract } from "../../lib/contract";
import type { GuardrailRule, Severity } from "../../lib/types";
import { errorText, ErrorNote, useAsync } from "../common";
import { defaultRule, describeRule, RULE_TYPES, ruleTypeLabel, SEVERITIES, SEVERITY_META, SOURCE_OPTIONS, uniqueRuleId, type Field, type RuleType } from "./helpers";

const FIELD = "w-full rounded-md border border-border bg-background px-2 py-1 text-sm";
type Draft = GuardrailRule;

const same = (a: readonly Draft[], b: readonly Draft[]): boolean => JSON.stringify(a) === JSON.stringify(b);

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn("relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-border transition-colors", checked ? "bg-foreground" : "bg-muted")}
    >
      <span className={cn("inline-block size-3.5 rounded-full transition-transform", checked ? "translate-x-[18px] bg-background" : "translate-x-0.5 bg-muted-foreground")} />
    </button>
  );
}

/** Guardrail rules: a switch, thresholds and a severity per rule; add and remove; saved in one call. */
export function RulesEditor(_props: {}) {
  const rpc = useRpc<RpcContract>();
  const rules = useAsync(() => rpc.call("guardrails.rules.get"), []);
  const framework = useAsync(() => rpc.call("framework.get"), []);
  const [draft, setDraft] = useState<Draft[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [newType, setNewType] = useState<RuleType>("meeting_load");
  const server = rules.data?.rules ?? null;
  const areas = framework.data?.framework.areas ?? [];
  const labelOf = (key: string): string => areas.find((a) => a.key === key)?.label ?? key;

  // Follow the server until the user edits.
  useEffect(() => {
    if (server !== null && (draft === null || same(draft, server))) setDraft(server);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server]);
  const edited = draft !== null && server !== null && !same(draft, server);

  if (draft === null) return <ErrorNote message={rules.error} />;

  const patch = (next: Draft[]) => {
    setSaved(false);
    setDraft(next);
  };
  const patchRule = (i: number, change: Partial<Draft>) => patch(draft.map((r, at) => (at === i ? { ...r, ...change } : r)));
  const patchBody = (i: number, key: string, value: unknown) => patch(draft.map((r, at) => (at === i ? { ...r, rule: { ...r.rule, [key]: value } as Draft["rule"] } : r)));
  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      const out = await rpc.call("guardrails.rules.set", { rules: draft });
      setDraft(out.rules);
      setSaved(true);
      rules.reload();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const input = (i: number, rule: Draft, f: Field) => {
    const body = rule.rule as Record<string, unknown>;
    if (f.kind === "num") {
      return (
        <label key={f.key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {f.label}
          <input type="number" aria-label={`${ruleTypeLabel(rule.rule.type)}: ${f.label}`} className={`${FIELD} w-20`} min={f.min} max={f.max} step={1} value={Number(body[f.key] ?? f.min)}
            onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) patchBody(i, f.key, Math.min(f.max, Math.max(f.min, n))); }} />
          {f.unit}
        </label>
      );
    }
    if (f.kind === "area") {
      const value = (body[f.key] as string | null) ?? "";
      return (
        <label key={f.key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {f.label}
          <select className={`${FIELD} w-auto`} value={value} onChange={(e) => patchBody(i, f.key, e.target.value === "" ? null : e.target.value)}>
            {f.nullable ? <option value="">Any area</option> : null}
            {areas.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
            {value !== "" && !areas.some((a) => a.key === value) ? <option value={value}>{value}</option> : null}
          </select>
        </label>
      );
    }
    if (f.kind === "areas") {
      const picked = (body[f.key] as string[] | undefined) ?? [];
      return (
        <fieldset key={f.key} className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <legend className="sr-only">{f.label}</legend>
          {f.label}
          {areas.map((a) => (
            <label key={a.key} className="flex items-center gap-1">
              <input type="checkbox" checked={picked.includes(a.key)} onChange={(e) => {
                const next = e.target.checked ? [...picked, a.key] : picked.filter((k) => k !== a.key);
                if (next.length > 0) patchBody(i, f.key, next);
              }} />
              {a.label}
            </label>
          ))}
        </fieldset>
      );
    }
    const value = (body[f.key] as string | null) ?? "";
    return (
      <label key={f.key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {f.label}
        <select className={`${FIELD} w-auto`} value={value} onChange={(e) => patchBody(i, f.key, e.target.value === "" ? null : e.target.value)}>
          <option value="">Any source</option>
          {SOURCE_OPTIONS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </label>
    );
  };

  return (
    <div className="space-y-3">
      <ErrorNote message={error ?? rules.error} />
      {draft.length === 0 ? <p className="text-sm text-muted-foreground">No rules. Add one below.</p> : null}
      {draft.map((rule, i) => {
        const fields = RULE_TYPES.find((t) => t.type === rule.rule.type)?.fields ?? [];
        return (
          <div key={rule.id} className={cn("space-y-2 rounded-lg border border-border p-2.5", !rule.enabled && "opacity-60")}>
            <div className="flex flex-wrap items-center gap-2">
              <Switch checked={rule.enabled} label={`${ruleTypeLabel(rule.rule.type)} (${rule.id}) enabled`} onChange={(enabled) => patchRule(i, { enabled })} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{ruleTypeLabel(rule.rule.type)}</p>
                <p className="text-xs text-muted-foreground">{describeRule(rule.rule, labelOf)}</p>
              </div>
              <select aria-label={`${ruleTypeLabel(rule.rule.type)}: severity`} className={`${FIELD} w-auto`} value={rule.severity} onChange={(e) => patchRule(i, { severity: e.target.value as Severity })}>
                {SEVERITIES.map((s) => <option key={s} value={s}>{SEVERITY_META[s].label}</option>)}
              </select>
              <Button variant="ghost" size="icon" aria-label={`Remove ${ruleTypeLabel(rule.rule.type)}`} onClick={() => patch(draft.filter((_, at) => at !== i))}>
                <Icon name="Trash2" className="size-3.5" />
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">{fields.map((f) => input(i, rule, f))}</div>
          </div>
        );
      })}

      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Rule type to add" className={`${FIELD} w-auto`} value={newType} onChange={(e) => setNewType(e.target.value as RuleType)}>
          {RULE_TYPES.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
        </select>
        <Button variant="outline" size="sm" onClick={() => patch([...draft, { id: uniqueRuleId(newType, draft.map((r) => r.id)), enabled: true, severity: "warning", rule: defaultRule(newType, areas[0]?.key ?? "delivery") }])}>
          <Icon name="Plus" className="size-3.5" />Add rule
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy || !edited} onClick={() => void save()}>
          <Icon name={busy ? "Loader" : "Save"} className="size-3.5" />Save rules
        </Button>
        <Button variant="ghost" size="sm" disabled={!edited} onClick={() => { setDraft(server); setSaved(false); }}>Discard changes</Button>
        {saved && !edited ? <span className="text-xs text-muted-foreground">Saved.</span> : null}
      </div>
    </div>
  );
}
