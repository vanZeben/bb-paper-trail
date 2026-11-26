// Settings. Every auto-set section is already filled by the agent from the role card; each shows where it came from
// ("set by your agent · basis") and an Edit toggle. Sections have DOM anchors, so onboarding's "Edit" links can pass
// `section` to open and scroll to one.
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import type { RpcContract } from "../../lib/contract";
import { Card, useAsync } from "../common";
import { RulesEditor } from "../guardrails/RulesEditor";
import { dismissFiguredOut, figuredOutDismissed } from "../onboarding/dismiss";
import { FiguredOut } from "../onboarding/FiguredOut";
import { PlanEditor } from "../plan/PlanEditor";
import { TargetsEditor } from "../time/TargetsEditor";
import { AdvancedPanel } from "./AdvancedPanel";
import { ConnectorsPanel } from "./Connectors";
import { FrameworkPanel } from "./Framework";
import { GoalsPanel } from "./GoalsPanel";
import { MigratePanel } from "./Migrate";
import { ProfilePanel } from "./ProfilePanel";
import { scrollToSection, sectionDomId, SETTINGS_SECTIONS, type SettingsSection } from "./sections";
import { FrameworkSummary, GoalsSummary, GuardrailsSummary, SplitSummary } from "./Summaries";

const TITLE = Object.fromEntries(SETTINGS_SECTIONS.map((s) => [s.id, s.label])) as Record<SettingsSection, string>;

function Section({ id, aside, auto, open, onToggle, summary, children }: {
  id: SettingsSection;
  aside?: string;
  /** Set when the agent filled this section in; the text is the basis (may be empty). Null for sections the user owns. */
  auto: string | null;
  open: boolean;
  onToggle: () => void;
  summary?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div id={sectionDomId(id)} className="scroll-mt-4">
      <Card title={TITLE[id]} aside={aside}>
        {auto === null ? (
          children
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>set by your agent{auto !== "" ? ` · ${auto}` : ""}</span>
              <Button variant="ghost" size="sm" aria-expanded={open} onClick={onToggle}>{open ? "Done" : "Edit"}</Button>
            </div>
            {open ? children : summary}
          </div>
        )}
      </Card>
    </div>
  );
}

export function SettingsTab({ section = null }: { section?: SettingsSection | null }) {
  const rpc = useRpc<RpcContract>();
  const setup = useAsync(() => rpc.call("setup.get"), []);
  const [open, setOpen] = useState<Partial<Record<SettingsSection, boolean>>>({});
  const [, bump] = useState(0);
  const profile = setup.data?.profile ?? null;
  const proposal = setup.data?.proposal ?? null;
  const set = profile?.setupAt != null;
  const basis = (key: string) => (set ? (proposal?.basis[key] ?? "") : null);

  const reveal = (id: SettingsSection) => {
    setOpen((o) => ({ ...o, [id]: true }));
    // Wait a frame so an expanded section has its final position before scrolling.
    requestAnimationFrame(() => scrollToSection(id));
  };
  useEffect(() => {
    if (section !== null) reveal(section);
  }, [section]);

  const sectionProps = (id: SettingsSection, key: string) => ({ id, auto: basis(key), open: open[id] === true, onToggle: () => setOpen((o) => ({ ...o, [id]: !o[id] })) });
  const showSummary = profile !== null && proposal !== null && set && !figuredOutDismissed(profile.setupAt);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        You don't have to configure any of this. Your agent set it up from your role card; change what you disagree with.
      </p>
      {showSummary ? (
        <FiguredOut
          profile={profile}
          proposal={proposal}
          kept={setup.data?.kept}
          onEdit={reveal}
          onClose={() => {
            dismissFiguredOut(profile.setupAt);
            bump((n) => n + 1);
          }}
        />
      ) : null}

      <div id={sectionDomId("profile")} className="scroll-mt-4">
        <Card title={TITLE.profile} aside="Who you are in transcripts and tools, your role card, and what the agent worked out from it.">
          <ProfilePanel />
        </Card>
      </div>
      <Section {...sectionProps("goals", "goals")} aside="What you are working toward this half. Progress is judged against these." summary={<GoalsSummary />}>
        <GoalsPanel />
      </Section>
      <Section {...sectionProps("framework", "framework")} aside="The areas and rubric every day and week is rated against." summary={<FrameworkSummary />}>
        <FrameworkPanel />
      </Section>
      <Section {...sectionProps("split", "targets")} aside="Where you want your time to go, as a share of each area." summary={<SplitSummary />}>
        <TargetsEditor />
      </Section>
      <Section {...sectionProps("guardrails", "guardrails")} aside="Warnings when your week drifts from what you set out to do." summary={<GuardrailsSummary />}>
        <RulesEditor />
      </Section>
      <Section {...sectionProps("plan", "plan")} aside="Each week's intentions. The agent plans them from your goals; change them here." summary={<p className="text-sm">Planned each week by your agent from your goals.</p>}>
        <PlanEditor />
      </Section>
      <div id={sectionDomId("sources")} className="scroll-mt-4">
        <Card title={TITLE.sources} aside="What the capture agent can reach on the capture host.">
          <ConnectorsPanel />
        </Card>
      </div>
      <div id={sectionDomId("data")} className="scroll-mt-4">
        <Card title={TITLE.data}>
          <MigratePanel />
        </Card>
      </div>
      <div id={sectionDomId("advanced")} className="scroll-mt-4">
        <Card title={TITLE.advanced} aside="Manual capture runs. The agent already captures on its schedule.">
          <AdvancedPanel />
        </Card>
      </div>
    </div>
  );
}
