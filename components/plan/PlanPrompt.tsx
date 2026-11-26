// A compact one-liner for the Graph tab: this week's auto-planned intentions and how many have advanced. Display only:
// the agent plans the week itself, and there is nothing to type here. Renders nothing when there is no plan yet.
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import type { RpcContract } from "../../lib/contract";
import { useAsync } from "../common";

export function PlanPrompt({ week }: { week: string }) {
  const rpc = useRpc<RpcContract>();
  const plan = useAsync(() => rpc.call("plan.get", { week }), [week]);
  const data = plan.data;
  if (!data || data.items.length === 0) return null;
  const advanced = data.results.filter((r) => r.status === "done" || r.status === "partial").length;
  const auto = data.items.some((i) => i.source === "inferred");
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
      <Icon name="ListChecks" className="size-4 text-muted-foreground" />
      <span>
        This week{auto ? " (auto-planned)" : ""}: {data.items.length} intention{data.items.length === 1 ? "" : "s"} · {advanced} advanced
      </span>
    </div>
  );
}
