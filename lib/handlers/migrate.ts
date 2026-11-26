/** handlers/migrate.ts — data bundles: import, export and the last import's summary. Logic lives in lib/features/migrate. */
import { exportBundle } from "../features/migrate/export";
import { importBundle, lastImport } from "../features/migrate/import";
import type { HandlersFn } from "./types";

type Methods = "migrate.status" | "data.export" | "data.import";

export const handlers: HandlersFn<Methods> = (ctx, service) => {
  let running = false;

  return {
    "migrate.status": async () => {
      const last = await lastImport(ctx);
      return { running, imported: last?.imported ?? { days: 0, weeks: 0, records: 0 }, skipped: last?.skipped ?? 0, errors: last?.errors ?? [], warnings: last?.warnings ?? [], at: last?.at ?? null };
    },

    "data.export": async ({ from, to }) => ({ bundle: await exportBundle(ctx, { from, to }) }),

    "data.import": async ({ bundle, applyFramework }) => {
      if (running) throw new Error("An import is already running.");
      running = true;
      ctx.publish();
      try {
        const { at: _at, ...summary } = await importBundle(bundle, { ctx, service }, { applyFramework });
        return summary;
      } finally {
        running = false;
        ctx.publish();
      }
    },
  };
};
