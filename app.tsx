// Paper Trail — frontend entry.
//
// One sidebar page with six tabs: Graph (default), Time, Plan, Threads, Review, Settings. Until onboarding is done the
// page shows the Onboarding flow instead, with a "Skip for now" link to the tabs. Data comes from this plugin's RPC;
// the server pushes a realtime signal on CHANNEL whenever stored state or the run queue moves.
import { useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "./lib/contract";
import { PLUGIN_ID, PLUGIN_NAME } from "./lib/meta";
import { Segmented, useAsync } from "./components/common";
import { Graph } from "./components/graph/Graph";
import { Onboarding } from "./components/onboarding/Onboarding";
import { PlanTab } from "./components/plan/PlanTab";
import { ReviewTab } from "./components/review/ReviewTab";
import { SettingsTab } from "./components/settings/SettingsTab";
import type { SettingsSection } from "./components/settings/sections";
import { ThreadsTab } from "./components/threads/ThreadsTab";
import { TimeTab } from "./components/time/TimeTab";

type Tab = "graph" | "time" | "plan" | "threads" | "review" | "settings";
const TABS = [
  { id: "graph", label: "Graph", icon: "LayoutGrid" },
  { id: "time", label: "Time", icon: "Clock" },
  { id: "plan", label: "Week", icon: "ListChecks" },
  { id: "threads", label: "Threads", icon: "GitBranch" },
  { id: "review", label: "Review", icon: "FileText" },
  { id: "settings", label: "Settings", icon: "Settings" },
] as const;
const isTab = (value: string | undefined): value is Tab => TABS.some((t) => t.id === value);

function PaperTrailPage({ subPath }: { subPath?: string }) {
  const rpc = useRpc<RpcContract>();
  const [tab, setTab] = useState<Tab>(isTab(subPath) ? subPath : "graph");
  const [skipped, setSkipped] = useState(false);
  const [section, setSection] = useState<SettingsSection | null>(null);
  // Once shown, Onboarding stays mounted until its own onClose ("Looks good"): finishing setup flips `completed` before
  // the "Here's what I figured out" screen has been seen.
  const [onboardingShown, setOnboardingShown] = useState(false);
  // Re-read on the realtime channel, so finishing onboarding in the flow swaps the page to the tabs by itself.
  // If the call fails (e.g. the method is not implemented yet) the tabs are shown rather than a dead page.
  const onboarding = useAsync(() => rpc.call("onboarding.get"), []);
  const pending = onboarding.data !== null && !onboarding.data.completed && !skipped;
  if (pending && !onboardingShown) setOnboardingShown(true);
  const needsOnboarding = pending || (onboardingShown && !skipped);

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-6xl space-y-4 px-4 pb-8 pt-3 md:px-5 md:pt-4">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-lg font-semibold leading-tight">{PLUGIN_NAME}</h1>
          {needsOnboarding ? (
            <button type="button" onClick={() => setSkipped(true)} className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground">
              Skip for now
            </button>
          ) : null}
        </header>

        {needsOnboarding ? (
          <Onboarding onEdit={(s) => { setSection(s); setTab("settings"); }} onClose={() => setOnboardingShown(false)} />
        ) : (
          <>
            <Segmented label={`${PLUGIN_NAME} view`} value={tab} onChange={setTab} options={TABS} />
            {tab === "graph" ? <Graph /> : null}
            {tab === "time" ? <TimeTab /> : null}
            {tab === "plan" ? <PlanTab /> : null}
            {tab === "threads" ? <ThreadsTab /> : null}
            {tab === "review" ? <ReviewTab /> : null}
            {tab === "settings" ? <SettingsTab section={section} /> : null}
          </>
        )}
      </div>
    </div>
  );
}

// Sidebar glyph: a receipt. Registered so the sidebar entry is distinct from other plugin pages.
const NAV_ICON = `${PLUGIN_ID}-receipt`;
function ReceiptIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 3v18l2.5-1.5L10 21l2-1.5 2 1.5 2.5-1.5L19 21V3z" />
      <path d="M9 8h6M9 12h6" />
    </svg>
  );
}

export default definePluginApp((app) => {
  app.experimental_icons.register({ name: NAV_ICON, component: ReceiptIcon });
  app.slots.navPanel({
    id: PLUGIN_ID,
    title: PLUGIN_NAME,
    icon: NAV_ICON,
    // Routed at /plugins/paper-trail/paper-trail; `subPath` selects a tab (Graph by default).
    path: PLUGIN_ID,
    component: PaperTrailPage,
  });
});
