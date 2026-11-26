/** queue.ts — one work-log run at a time; a second request for the same key joins the pending one. */
import type { WorklogStatus } from "../types";

export interface SerialQueue {
  /**
   * A request for a key that is already pending joins it. With `afterRunning`, a request that finds the key already
   * RUNNING (not just waiting) queues a fresh run behind it instead, e.g. a recapture that the running run will not do.
   */
  enqueue(key: string, task: (setStep: (step: string) => void) => Promise<void>, opts?: { afterRunning?: boolean }): Promise<void>;
  /** "waiting" = queued but not started; "running" = started; "idle" = not pending. */
  state(key: string): "idle" | "waiting" | "running";
  status(): WorklogStatus;
}

export function createSerialQueue(onChange: () => void = () => undefined, now: () => Date = () => new Date()): SerialQueue {
  const pending = new Map<string, { promise: Promise<void>; started: boolean }>();
  const waiting: string[] = [];
  let running: { key: string; startedAt: string; step: string | null } | null = null;
  let lastError: { key: string; message: string; at: string } | null = null;
  let tail: Promise<void> = Promise.resolve();

  return {
    state: (key) => {
      const entry = pending.get(key);
      return entry === undefined ? "idle" : entry.started ? "running" : "waiting";
    },
    enqueue(key, task, opts = {}) {
      const existing = pending.get(key);
      if (existing !== undefined && !(existing.started && opts.afterRunning === true)) return existing.promise;
      waiting.push(key);
      const entry = { promise: Promise.resolve(), started: false };
      const run = tail.then(async () => {
        entry.started = true;
        waiting.splice(waiting.indexOf(key), 1);
        running = { key, startedAt: now().toISOString(), step: null };
        onChange();
        try {
          await task((step) => {
            if (running !== null) running = { ...running, step };
            onChange();
          });
          if (lastError?.key === key) lastError = null;
        } catch (cause) {
          lastError = { key, message: cause instanceof Error ? cause.message : String(cause), at: now().toISOString() };
          throw cause;
        } finally {
          running = null;
          if (pending.get(key) === entry) pending.delete(key);
          onChange();
        }
      });
      entry.promise = run;
      pending.set(key, entry);
      // A rejected task never blocks the next one.
      tail = run.catch(() => undefined);
      onChange();
      return run;
    },
    status: () => ({ running: running === null ? null : { ...running }, queued: [...waiting], lastError: lastError === null ? null : { ...lastError } }),
  };
}
