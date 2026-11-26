// One-line summaries shown while an auto-set Settings section is collapsed. Each reads its own current state.
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../../lib/contract";
import { useAsync } from "../common";

const Line = ({ children }: { children: string }) => <p className="text-sm">{children}</p>;

export function GoalsSummary() {
  const rpc = useRpc<RpcContract>();
  const goals = useAsync(() => rpc.call("goals.get"), []);
  const list = goals.data?.goals ?? [];
  return <Line>{goals.data === null ? "Loading…" : list.length === 0 ? "No goals yet." : list.map((g) => g.text).join("; ")}</Line>;
}

export function FrameworkSummary() {
  const rpc = useRpc<RpcContract>();
  const fw = useAsync(() => rpc.call("framework.get"), []);
  const f = fw.data?.framework;
  return <Line>{f ? `${f.name}: ${f.areas.map((a) => a.label).join(", ")}` : "Loading…"}</Line>;
}

export function SplitSummary() {
  const rpc = useRpc<RpcContract>();
  const fw = useAsync(() => rpc.call("framework.get"), []);
  const targets = useAsync(() => rpc.call("targets.get"), []);
  const f = fw.data?.framework;
  const t = targets.data;
  if (!f || targets.loading) return <Line>Loading…</Line>;
  if (t === null) return <Line>No work split set.</Line>;
  return <Line>{f.areas.map((a) => `${a.label} ${Math.round(t.targets[a.key] ?? 0)}%`).join(" · ")}</Line>;
}

export function GuardrailsSummary() {
  const rpc = useRpc<RpcContract>();
  const rules = useAsync(() => rpc.call("guardrails.rules.get"), []);
  const n = rules.data?.rules.length;
  return <Line>{n === undefined ? "Loading…" : n === 0 ? "No guardrail rules." : `${n} rule${n === 1 ? "" : "s"} watching your week.`}</Line>;
}
