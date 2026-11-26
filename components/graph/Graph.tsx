// The Graph tab, top to bottom: guardrail banner, this week's plan prompt, lens picker + grid + legend, a summary strip
// for the visible range, a capture status line, then the day or week panel. Data comes from grid.get / day.get / week.get;
// every read re-runs when the plugin's realtime channel fires (useAsync).
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../../lib/contract";
import type { OverrideTarget } from "../../lib/types";
import { Card, Empty, ErrorNote, StatTile, useAsync } from "../common";
import { GuardrailBanner } from "../guardrails/Banner";
import { PlanPrompt } from "../plan/PlanPrompt";
import { Controls } from "./Controls";
import { DayPanel } from "./DayPanel";
import { Grid, type Selection } from "./Grid";
import { Legend } from "./Legend";
import { LENS_CSS, LENS_STORAGE_KEY, parseLens, type Lens } from "./lenses";
import { LensPicker } from "./LensPicker";
import { OverrideControl } from "./OverrideControl";
import { formatPct } from "./helpers";
import { summarise } from "./summary";
import { WeekPanel } from "./WeekPanel";

const WEEKS = 36;

const readLens = (): string | null => {
  try {
    return window.localStorage.getItem(LENS_STORAGE_KEY);
  } catch {
    return null;
  }
};

const defaultRenderOverride = (target: OverrideTarget): ReactNode => <OverrideControl target={target} />;

export function Graph({ renderOverride = defaultRenderOverride }: { renderOverride?: (target: OverrideTarget) => ReactNode }) {
  const rpc = useRpc<RpcContract>();
  const grid = useAsync(() => rpc.call("grid.get", { weeks: WEEKS }), []);
  const runStatus = useAsync(() => rpc.call("run.status"), []);
  const stats = useAsync(() => rpc.call("override.stats", { weeks: WEEKS }), []);
  const [chosen, setChosen] = useState<string | null>(readLens);
  const [selection, setSelection] = useState<Selection>(null);
  const [error, setError] = useState<string | null>(null);
  const summary = useMemo(() => (grid.data ? summarise(grid.data.weeks, stats.data) : null), [grid.data, stats.data]);

  if (!grid.data || !summary) return <Empty>{grid.loading ? "Loading the work log…" : grid.error ?? "No data."}</Empty>;
  const g = grid.data;
  const lens: Lens = parseLens(chosen, g.lensAvailability);
  const pick = (next: Lens) => {
    setChosen(next);
    try {
      window.localStorage.setItem(LENS_STORAGE_KEY, next);
    } catch {
      // Storage can be unavailable (private mode); the choice then lasts for this session only.
    }
  };
  const status = runStatus.data ?? g.status;
  const share = (value: number | null) => (value === null ? "–" : formatPct(value * 100));
  return (
    <div className="rc-viz space-y-4">
      <style>{LENS_CSS}</style>
      <GuardrailBanner />
      <PlanPrompt week={g.currentWeek} />
      <Card title={`Past ${WEEKS} weeks`} aside="Click a day for its panel, a week number for the report.">
        <div className="mb-3">
          <LensPicker lens={lens} availability={g.lensAvailability} onChange={pick} />
        </div>
        <Grid grid={g} lens={lens} selection={selection} onSelect={setSelection} />
        <Legend lens={lens} areas={g.areas} />
      </Card>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <StatTile label="Days captured" value={summary.daysCaptured} icon="CalendarCheck" hint={`${summary.ratedDays} rated`} />
        <StatTile label="Exceeds or meets" value={share(summary.exceedsMeetsShare)} hint="of rated days" />
        <StatTile label="Avg meetings" value={summary.avgMeetingPct === null ? "–" : formatPct(summary.avgMeetingPct)} hint="of the working day" />
        <StatTile label="Evidence items" value={summary.evidenceItems} />
        <StatTile label="Agreement" value={share(summary.agreementRate)} hint={summary.reviewed === 0 ? "nothing reviewed yet" : `${summary.reviewed} reviewed`} />
      </div>
      <Controls grid={g} status={status} />
      <ErrorNote message={error ?? grid.error} />
      {selection?.type === "day" ? (
        <DayPanel
          date={selection.date}
          status={status}
          timeZone={g.timeZone}
          workdayHours={g.workdayHours}
          onClose={() => setSelection(null)}
          onError={setError}
          renderOverride={renderOverride}
        />
      ) : null}
      {selection?.type === "week" ? (
        <WeekPanel week={selection.week} status={status} areas={g.areas} onClose={() => setSelection(null)} onError={setError} renderOverride={renderOverride} />
      ) : null}
    </div>
  );
}
