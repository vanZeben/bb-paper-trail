import type { Registry } from "../../engine/extensions";
import { recheckIfStale, type HostLister } from "./check";

/** Set by lib/handlers/connectors.ts (the handlers get `env.hosts`); the hook has no other way to list hosts. */
let hostLister: HostLister = async () => [];
export const provideHosts = (lister: HostLister): void => {
  hostLister = lister;
};

/** A saved week is the scheduled moment: re-run a stale connector check, at most once a week (never awaited). */
export function register(reg: Registry): void {
  reg.weekHooks.push({
    id: "connectors",
    afterWeekSaved: async (_week, ctx) => {
      await recheckIfStale(ctx, hostLister);
    },
  });
}
