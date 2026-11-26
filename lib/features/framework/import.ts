/** import.ts — runs the role-doc import in the background and stores the result as the framework proposal. */
import type { FeatureCtx } from "../../engine/extensions";
import { docRefLabel, importDocJob, readProposal, type DocRef } from "../../framework/import-doc";
import { KIND } from "../../storage/port";
import type { FrameworkProposal } from "../../types";

const MIN = 60_000;

/** Starts the import and returns at once. Throws when one is already running. */
export async function startImport(ctx: FeatureCtx, ref: DocRef): Promise<void> {
  const s = ctx.settings();
  const value = ref.value.trim();
  if (value === "") throw new Error("Nothing to import: the document reference is empty.");
  if (ref.kind === "url" && !/^https?:\/\/\S+$/.test(value)) throw new Error("That is not an http(s) URL.");
  const timeoutMs = s.judgeTimeoutMinutes * MIN;
  const current = await readProposal(ctx.store);
  // A "running" proposal older than the timeout is a leftover from a restart; it does not block a new import.
  if (current?.status === "running" && ctx.now().getTime() - Date.parse(current.at) < timeoutMs + MIN) throw new Error("A framework import is already running.");

  const base = await ctx.framework();
  const sourceRef = docRefLabel(ref);
  const write = async (proposal: FrameworkProposal) => {
    await ctx.store.set(KIND.framework, "proposal", proposal);
    ctx.publish();
  };
  await write({ status: "running", sourceRef, framework: null, error: null, at: ctx.now().toISOString() });
  void ctx.runner
    .runJob(importDocJob({ kind: ref.kind, value: ref.kind === "text" ? ref.value : value }, base, ctx.now), { model: s.judgeModel || undefined, timeoutMs, retryOnWorkerError: false })
    .then(
      (framework) => write({ status: "ready", sourceRef, framework, error: null, at: ctx.now().toISOString() }),
      (cause: unknown) => write({ status: "failed", sourceRef, framework: null, error: cause instanceof Error ? cause.message : String(cause), at: ctx.now().toISOString() }),
    )
    .catch((cause: unknown) => ctx.log.warn(`framework import: could not store the result: ${cause instanceof Error ? cause.message : String(cause)}`));
}
