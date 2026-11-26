/** handlers/connectors.ts — connectors.get / connectors.check. The check runs in the background; the app re-reads on the realtime channel. */
import { isConnectorCheckStale } from "../capture/connector-check";
import { readCheck, startConnectorCheck } from "../features/connectors/check";
import { provideHosts } from "../features/connectors";
import type { HandlersFn } from "./types";

type Methods = "connectors.get" | "connectors.check";

export const handlers: HandlersFn<Methods> = (ctx, _service, env) => {
  provideHosts(env.hosts);
  return {
    "connectors.get": async () => {
      const [check, hosts] = await Promise.all([readCheck(ctx), env.hosts()]);
      return { check, stale: isConnectorCheckStale(check, ctx.now()), hosts };
    },
    "connectors.check": () => {
      if (ctx.settings().enabledSources.length === 0) throw new Error("No sources are enabled. Set \"Enabled sources\" in the plugin settings.");
      startConnectorCheck(ctx, env.hosts);
      return { ok: true as const };
    },
  };
};
