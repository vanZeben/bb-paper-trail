// "Here's what I figured out": one line per inferred item with its basis and an Edit link into Settings. Non-blocking:
// everything is already applied, so "Looks good" only closes it.
import { Button } from "@/components/ui/button";
import type { Profile, SetupProposal } from "../../lib/types";
import { Card } from "../common";
import { describeRule } from "../guardrails/helpers";
import type { SettingsSection } from "../settings/sections";

interface Row {
  label: string;
  value: string;
  basis: string | undefined;
  section: SettingsSection;
}

export function figuredOutRows(profile: Profile, proposal: SetupProposal): Row[] {
  const inf = profile.inferred;
  const labelOf = (key: string) => proposal.framework.areas.find((a) => a.key === key)?.label ?? key;
  const split = proposal.framework.areas.map((a) => `${a.label} ${Math.round(proposal.targets[a.key] ?? 0)}%`).join(" · ");
  return [
    { label: "Level", value: inf.level ?? "Not clear from the role card", basis: inf.basis.level, section: "profile" },
    { label: "Scope", value: inf.scope ?? "Not clear from the role card", basis: inf.basis.scope, section: "profile" },
    { label: "Manager", value: inf.managerName ?? "None found", basis: inf.basis.managerName, section: "profile" },
    { label: "Review cadence", value: inf.reviewCadence ?? "Not found", basis: inf.basis.reviewCadence, section: "profile" },
    { label: "Areas", value: proposal.framework.areas.map((a) => a.label).join(", "), basis: proposal.basis.framework, section: "framework" },
    { label: "Work split", value: split, basis: proposal.basis.targets, section: "split" },
    {
      label: "Guardrails",
      value: proposal.guardrails.length === 0 ? "None" : proposal.guardrails.map((g) => describeRule(g.rule, labelOf)).join(" "),
      basis: proposal.basis.guardrails,
      section: "guardrails",
    },
    { label: "Goals", value: proposal.goals.map((g) => g.text).join("; "), basis: proposal.basis.goals, section: "goals" },
  ];
}

/** "Kept your edits to: work split, guardrails", or null when a re-run replaced nothing the user had edited. */
export function keptLine(kept: readonly string[] | undefined): string | null {
  return kept !== undefined && kept.length > 0 ? `Kept your edits to: ${kept.join(", ")}.` : null;
}

export function FiguredOut({ profile, proposal, note, kept, onEdit, onClose }: { profile: Profile; proposal: SetupProposal; note?: string | null; kept?: readonly string[]; onEdit: (section: SettingsSection) => void; onClose: () => void }) {
  return (
    <Card title="Here's what I figured out" aside="All of this is already applied and your first four weeks are being captured. Change anything now or later in Settings.">
      <ul className="divide-y divide-border rounded-lg border border-border">
        {figuredOutRows(profile, proposal).map((row) => (
          <li key={row.label} className="flex flex-wrap items-start gap-x-3 gap-y-0.5 px-3 py-2 text-sm">
            <span className="w-32 shrink-0 font-medium">{row.label}</span>
            <span className="min-w-0 flex-1">
              {kept?.includes(row.label.toLowerCase()) ? (
                <>
                  <span className="block">Your version, kept</span>
                  <span className="block text-xs text-muted-foreground">The agent suggested: {row.value}</span>
                </>
              ) : (
                <>
                  <span className="block">{row.value}</span>
                  <span className="block text-xs text-muted-foreground">{row.basis ? `Basis: ${row.basis}` : "No basis recorded."}</span>
                </>
              )}
            </span>
            <button type="button" onClick={() => onEdit(row.section)} className="shrink-0 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
              Edit
            </button>
          </li>
        ))}
      </ul>
      {keptLine(kept) ? <p className="mt-2 text-xs text-muted-foreground">{keptLine(kept)}</p> : null}
      {note ? <p className="mt-2 text-xs text-muted-foreground">{note}</p> : null}
      <div className="mt-3">
        <Button size="sm" onClick={onClose}>Looks good</Button>
      </div>
    </Card>
  );
}
