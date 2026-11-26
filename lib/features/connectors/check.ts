/**
 * check.ts — runs the connector check and stores it as KIND.connectors "latest". Single-flight: a second request
 * while one is running does nothing. The scheduled path re-runs a stale check at most once a week.
 */
import { connectorCheckJob, isConnectorCheckStale } from "../../capture/connector-check";
import type { FeatureCtx } from "../../engine/extensions";
import { KIND } from "../../storage/port";
import { connectorCheckSchema, type ConnectorCheck } from "../../types";

export type HostInfo = { id: string; name: string; connected: boolean };
export type HostLister = () => Promise<HostInfo[]>;

/** meta key: when the scheduled path last tried a re-check (success or not). */
export const AUTO_CHECK_META = "connectors_auto_check_at";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The capture host as the worker resolves it: the named host, else the first connected one. */
export function pickHost(hosts: readonly HostInfo[], wanted: string): { id: string; name: string } {
  const name = wanted.trim().toLowerCase();
  const found = name !== "" ? hosts.find((h) => h.name.trim().toLowerCase() === name) : hosts.find((h) => h.connected);
  return found !== undefined ? { id: found.id, name: found.name } : { id: "", name: wanted.trim() || "unknown" };
}

export const readCheck = (ctx: Pick<FeatureCtx, "store">): Promise<ConnectorCheck | null> => ctx.store.get(KIND.connectors, "latest", connectorCheckSchema);

let inFlight: Promise<ConnectorCheck | null> | null = null;
/** Test hook: whether a check is running. */
export const checkRunning = (): boolean => inFlight !== null;

/** Runs the check and stores it. Resolves with the stored check, or null when one was already running. Throws on job failure. */
export function runConnectorCheck(ctx: FeatureCtx, hosts: HostLister): Promise<ConnectorCheck | null> {
  if (inFlight !== null) return Promise.resolve(null);
  const task = (async () => {
    const s = ctx.settings();
    if (s.enabledSources.length === 0) throw new Error("no sources are enabled");
    const [hostList, sources] = await Promise.all([
      hosts().catch((): HostInfo[] => []),
      ctx.runner.runJob(connectorCheckJob(s.enabledSources), {
        model: s.captureModel || undefined,
        timeoutMs: s.captureTimeoutMinutes * 60_000,
        retryOnWorkerError: false,
      }),
    ]);
    const host = pickHost(hostList, s.captureHost);
    const check: ConnectorCheck = { checkedAt: ctx.now().toISOString(), hostId: host.id, hostName: host.name, model: s.captureModel || null, sources };
    await ctx.store.set(KIND.connectors, "latest", check);
    ctx.publish();
    return check;
  })();
  inFlight = task;
  const clear = () => {
    inFlight = null;
  };
  task.then(clear, clear);
  return task;
}

/** Fire and forget; failures are logged (and the UI sees no new check). */
export function startConnectorCheck(ctx: FeatureCtx, hosts: HostLister): void {
  runConnectorCheck(ctx, hosts).catch((cause: unknown) => ctx.log.warn(`connector check failed: ${cause instanceof Error ? cause.message : String(cause)}`));
}

/** Scheduled path: re-run a stale check, at most one attempt per week. Returns true when a check was started. */
export async function recheckIfStale(ctx: FeatureCtx, hosts: HostLister): Promise<boolean> {
  if (!isConnectorCheckStale(await readCheck(ctx), ctx.now())) return false;
  const last = Date.parse((await ctx.store.getMeta(AUTO_CHECK_META)) ?? "");
  if (!Number.isNaN(last) && ctx.now().getTime() - last < WEEK_MS) return false;
  await ctx.store.setMeta(AUTO_CHECK_META, ctx.now().toISOString());
  startConnectorCheck(ctx, hosts);
  return true;
}
