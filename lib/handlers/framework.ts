/** handlers/framework.ts — framework.* and targets.*. The import proposal is stored, never applied automatically. */
import { startImport } from "../features/framework/import";
import { createFrameworkService } from "../framework/service";
import { readProposal } from "../framework/import-doc";
import type { HandlersFn } from "./types";

type Methods = "framework.get" | "framework.set" | "framework.usePreset" | "framework.importDoc" | "framework.proposal" | "targets.get" | "targets.set";

export const handlers: HandlersFn<Methods> = (ctx, _service, _env) => {
  const frameworks = createFrameworkService(ctx);
  return {
    "framework.get": () => frameworks.get(),
    "framework.set": async ({ framework }) => ({ framework: await frameworks.set(framework) }),
    "framework.usePreset": async ({ id }) => ({ framework: await frameworks.usePreset(id) }),
    "framework.importDoc": async ({ ref }) => {
      await startImport(ctx, ref);
      return { ok: true as const };
    },
    "framework.proposal": () => readProposal(ctx.store),
    "targets.get": () => frameworks.getTargets(),
    "targets.set": ({ targets }) => frameworks.setTargets(targets),
  };
};
