/**
 * runner.ts — model-backed job runner. A job is one prompt run on a fresh hidden agent thread (lib/worker.ts) on the
 * capture host. That agent holds the connectors; the plugin holds no credentials. The runner owns bounded
 * parallelism, strict JSON parsing, one retry on a malformed reply, and (for long jobs) no retry on a worker error.
 */
import { THREAD_TITLE_PREFIX } from "../meta";
import { extractJson } from "./json";

export interface Job<T = unknown> {
  kind: string;
  prompt: string;
  /** Replaces READ_ONLY_GUARD for this job (e.g. to allow one named read-only command). */
  guard?: string;
  validate: (data: unknown) => T;
  /**
   * Tool exposure the job needs. "none": a pure text job (rating, judgment, narrative) that must not touch any tool;
   * the worker spawns it in the most restrictive permission mode. "read" (default): the job reads connectors (MCP,
   * `gh`) and the worker uses the configured mode. The SDK has no switch to remove tools from a thread, so "none" is
   * also enforced by the job's guard text.
   */
  tools?: "none" | "read";
}

export interface WorkerRequest {
  prompt: string;
  title: string;
  model?: string | undefined;
  timeoutMs: number;
  /** See `Job.tools`. Absent means "read". */
  tools?: "none" | "read" | undefined;
}

/** Runs one prompt on a fresh hidden agent thread and returns its final assistant text. */
export interface WorkerPort {
  run(request: WorkerRequest): Promise<string>;
}

export interface RunOptions {
  model?: string | undefined;
  retries?: number;
  timeoutMs?: number;
  /** Long research jobs retry only a malformed reply, never a worker error or timeout. */
  retryOnWorkerError?: boolean;
}

export interface RunnerStatus {
  running: number;
  queued: number;
}

export interface Pool {
  run<T>(task: () => Promise<T>): Promise<T>;
  status(): RunnerStatus;
}

export function createPool(limit: () => number): Pool {
  let running = 0;
  const waiters: Array<() => void> = [];
  return {
    async run(task) {
      if (running >= Math.max(1, limit())) await new Promise<void>((resolve) => waiters.push(resolve));
      running += 1;
      try {
        return await task();
      } finally {
        running -= 1;
        waiters.shift()?.();
      }
    },
    status: () => ({ running, queued: waiters.length }),
  };
}

/**
 * Hidden threads cannot be given a tool blocklist, so read-only is enforced by instruction here and by the strict
 * reply schema each job validates against.
 */
export const READ_ONLY_GUARD = `You are a background data worker for a personal work-log plugin. You may only READ. Never create, edit, transition, comment on, send, schedule, respond to, label, delete or write anything in any system (issue trackers, wikis, chat, email, calendars, code hosts, notes, memory, the filesystem). Do not run shell commands or edit files. If a task seems to require a write, skip it and say so in your reply.`;

export interface Runner {
  runJob<T>(job: Job<T>, opts?: RunOptions): Promise<T>;
  status(): RunnerStatus;
}

export interface Log {
  info(message: string): void;
  warn(message: string): void;
}

export function createRunner(deps: {
  worker: WorkerPort;
  pool: Pool;
  defaultTimeoutMs: () => number;
  defaultModel: () => string | undefined;
  log?: Log;
}): Runner {
  const { worker, pool, log } = deps;
  return {
    status: pool.status,
    runJob<T>(job: Job<T>, opts: RunOptions = {}): Promise<T> {
      const { retries = 1, retryOnWorkerError = true } = opts;
      const timeoutMs = opts.timeoutMs ?? deps.defaultTimeoutMs();
      const model = opts.model ?? deps.defaultModel();
      return pool.run(async () => {
        let lastError: unknown;
        for (let attempt = 0; attempt <= retries; attempt += 1) {
          const started = Date.now();
          let workerFailed = false;
          try {
            const reply = await worker
              .run({ prompt: `${job.guard ?? READ_ONLY_GUARD}\n\n${job.prompt}`, title: `${THREAD_TITLE_PREFIX}${job.kind}`, model, timeoutMs, tools: job.tools })
              .catch((cause: unknown) => {
                workerFailed = true;
                throw cause;
              });
            const data = job.validate(extractJson(reply));
            log?.info(`job ${job.kind} ok in ${Date.now() - started}ms (attempt ${attempt + 1})`);
            return data;
          } catch (cause) {
            lastError = cause;
            log?.warn(`job ${job.kind} failed (attempt ${attempt + 1}): ${cause instanceof Error ? cause.message : String(cause)}`);
            if (workerFailed && !retryOnWorkerError) break;
          }
        }
        throw lastError;
      });
    },
  };
}
