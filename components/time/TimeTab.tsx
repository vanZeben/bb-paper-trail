// Time tab: where the time went against the targets, the drift card, and the targets editor.
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../../lib/contract";
import { Card, Empty, ErrorNote, useAsync } from "../common";
import { DriftCard } from "./DriftCard";
import { METHOD_NOTE } from "./helpers";
import { MixChart } from "./MixChart";
import { TargetsEditor } from "./TargetsEditor";

const WEEKS = 12;

export function TimeTab() {
  const rpc = useRpc<RpcContract>();
  const drift = useAsync(() => rpc.call("drift.get", { weeks: WEEKS }), []);
  const targets = useAsync(() => rpc.call("targets.get"), []);
  const framework = useAsync(() => rpc.call("framework.get"), []);

  const areas = framework.data?.framework.areas.map((a) => ({ key: a.key, label: a.label })) ?? [];
  const t = targets.data;
  if (drift.loading && !drift.data) return <Empty>Loading…</Empty>;
  if (targets.data === null && !targets.loading) {
    return (
      <div className="space-y-4">
        <ErrorNote message={drift.error ?? targets.error} />
        <Card title="Set your time targets" aside="Targets turn the mix into a comparison: without them there is nothing to drift from.">
          <TargetsEditor onSaved={() => { targets.reload(); drift.reload(); }} />
        </Card>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <ErrorNote message={drift.error ?? targets.error ?? framework.error} />
      {t && drift.data ? (
        <>
          <DriftCard snapshot={drift.data.snapshot} mix={drift.data.mix} targets={t} areas={areas} />
          <Card title={`Where the time went, last ${WEEKS} weeks`} aside={METHOD_NOTE}>
            {drift.data.mix.length === 0 ? <Empty>No weeks have been rated yet.</Empty> : <MixChart mix={drift.data.mix} targets={t} areas={areas} />}
          </Card>
        </>
      ) : null}
      <Card title="Targets">
        <TargetsEditor onSaved={() => { targets.reload(); drift.reload(); }} />
      </Card>
    </div>
  );
}
