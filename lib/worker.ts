/**
 * worker.ts — WorkerPort on bb agent threads. One job = one fresh hidden thread on the capture host. That agent holds
 * the connectors (MCP tools, `gh`, ...); this plugin holds no credentials. The thread is always archived and stopped.
 *
 * Host: setting `captureHost` is a machine name matched against `sdk.hosts.list()`. Empty = the primary host
 * (`sdk.system.config().primaryHostId`), else the first connected host. A missing or disconnected host throws a plain
 * error, which the queue shows as `lastError`.
 *
 * Environment: the personal project with `{ type: "host", hostId, workspace: { type: "personal" } }`, so no project
 * has to be created and no path configured. UNVERIFIED AT RUNTIME for plugin spawns: if bb refuses the personal
 * workspace, the worker falls back (once, then remembers) to the first standard project that has a local source on
 * the capture host, using `{ type: "host", hostId, workspace: { type: "unmanaged", path: <that source's path> } }`.
 * The path is only a working directory; read-only behaviour comes from the job guard, not from the workspace.
 */
import type { Settings } from "./settings";
import type { Log, WorkerPort, WorkerRequest } from "./engine/runner";
import type { PluginBbSdk } from "@get-bb/plugin-sdk";
import { THREAD_TITLE_PREFIX } from "./meta";

/** The slice of `PluginBbSdk` the worker uses. A fake of this shape is enough for tests (see the check below). */
export interface WorkerSdk {
  hosts: { list(): Promise<ReadonlyArray<{ id: string; name: string; status: string }>> };
  system: { config(): Promise<{ primaryHostId: string | null }> };
  projects: {
    list(args?: { includePersonal?: boolean }): Promise<
      ReadonlyArray<{ id: string; kind: string; name: string; sources: ReadonlyArray<{ hostId: string; path: string }> }>
    >;
  };
  threads: {
    spawn(args: SpawnArgs): Promise<{ id: string }>;
    get(args: { threadId: string }): Promise<{ status: string }>;
    wait(args: { threadId: string; status: "idle"; timeoutMs?: number; pollIntervalMs?: number }): Promise<unknown>;
    output(args: { threadId: string }): Promise<{ output: string | null }>;
    interactions: {
      list(args: { threadId: string }): Promise<ReadonlyArray<PendingLike>>;
    };
    archive(args: { threadId: string }): Promise<unknown>;
    stop(args: { threadId: string }): Promise<unknown>;
  };
}

/** What the worker reads from a pending interaction (both provider and plugin variants carry `status` and `payload.title`). */
export interface PendingLike {
  status: string;
  payload?: unknown;
}

export interface SpawnArgs {
  projectId: string;
  prompt: string;
  title: string;
  visibility: "hidden";
  permissionMode: "auto" | "accept-edits";
  model?: string;
  providerId?: string;
  pluginMetadata: { job: string };
  environment: {
    type: "host";
    hostId: string;
    workspace: { type: "personal" } | { type: "unmanaged"; path: string };
  };
}

// Compile-time guarantee that the real SDK satisfies the narrow interface (never executed).
export const _assertSdkShape = (sdk: PluginBbSdk): WorkerSdk => sdk;

export interface PingResult {
  ok: boolean;
  hostId?: string;
  hostName?: string;
  reply?: string;
  error?: string;
}

export interface WorkerDeps {
  sdk: WorkerSdk;
  /** Getter, so setting changes apply to the next job. */
  settings: () => Settings;
  log?: Log;
  /** Wait slice and empty-output poll interval. Default 2000 ms; tests lower it. */
  pollMs?: number;
}

interface Host {
  id: string;
  name: string;
}

/**
 * SDK facts (plugin-sdk d.ts): the spawn permission modes are "accept-edits" (approvals reviewed by the user, escalation
 * ask/deny, workspace scope), "auto" (an automatic reviewer approves within workspace scope) and "full" (no reviewer,
 * full scope). There is no spawn field to remove tools or MCP servers (`sessionOptions` is provider-specific and
 * opaque). So "full" is never used, tool-free jobs get "accept-edits" (any tool call that needs approval stalls on a
 * prompt nobody answers and the job fails as "permission needed"), and connector jobs get the configured mode.
 */
export function permissionModeFor(configured: string, tools: "none" | "read" | undefined): "auto" | "accept-edits" {
  if (tools === "none") return "accept-edits";
  return configured === "accept-edits" ? "accept-edits" : "auto";
}

const PING_PROMPT = 'Reply with exactly: {"ok":true}';
const PING_TIMEOUT_MS = 120_000;

const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Short human description of a pending interaction, for the "permission needed" error. */
function describePending(p: PendingLike): string {
  const payload = p.payload;
  if (typeof payload === "object" && payload !== null) {
    const rec = payload as Record<string, unknown>;
    if (typeof rec.title === "string" && rec.title !== "") return rec.title;
    if (typeof rec.kind === "string" && rec.kind !== "") return rec.kind;
  }
  return "a tool";
}

export function createWorker(deps: WorkerDeps): WorkerPort & { ping(): Promise<PingResult> } {
  const { sdk, settings, log } = deps;
  const pollMs = Math.max(1, deps.pollMs ?? 2000);
  let personalRefused = false;

  async function resolveHost(): Promise<Host> {
    const hosts = await sdk.hosts.list();
    const wanted = settings().captureHost.trim();
    if (wanted !== "") {
      const host = hosts.find((h) => h.name.trim().toLowerCase() === wanted.toLowerCase());
      if (host === undefined) {
        throw new Error(`capture host "${wanted}" not found (known hosts: ${hosts.map((h) => h.name).join(", ") || "none"})`);
      }
      if (host.status !== "connected") throw new Error(`capture host "${host.name}" is ${host.status}`);
      return host;
    }
    const { primaryHostId } = await sdk.system.config();
    if (primaryHostId !== null) {
      const primary = hosts.find((h) => h.id === primaryHostId);
      if (primary !== undefined) {
        if (primary.status !== "connected") throw new Error(`primary host "${primary.name}" is ${primary.status}; choose a capture host in settings`);
        return primary;
      }
    }
    const first = hosts.find((h) => h.status === "connected");
    if (first === undefined) throw new Error("no connected bb host to run capture on");
    return first;
  }

  async function spawn(host: Host, request: WorkerRequest): Promise<string> {
    const cfg = settings();
    const projects = await sdk.projects.list({ includePersonal: true });
    const personal = projects.find((p) => p.kind === "personal");
    const base = {
      prompt: request.prompt,
      title: request.title,
      visibility: "hidden" as const,
      permissionMode: permissionModeFor(cfg.workerPermissionMode, request.tools),
      pluginMetadata: { job: request.title.startsWith(THREAD_TITLE_PREFIX) ? request.title.slice(THREAD_TITLE_PREFIX.length) : request.title },
      ...(request.model === undefined || request.model === "" ? {} : { model: request.model }),
      ...(cfg.providerId === "" ? {} : { providerId: cfg.providerId }),
    };
    const fallback = () => {
      const standard = projects.find((p) => p.kind !== "personal" && p.sources.some((s) => s.hostId === host.id));
      const source = standard?.sources.find((s) => s.hostId === host.id);
      return standard === undefined || source === undefined ? null : { project: standard, path: source.path };
    };

    if (personal !== undefined && !personalRefused) {
      try {
        const thread = await sdk.threads.spawn({
          ...base,
          projectId: personal.id,
          environment: { type: "host", hostId: host.id, workspace: { type: "personal" } },
        });
        return thread.id;
      } catch (cause) {
        const alt = fallback();
        if (alt === null) throw cause;
        personalRefused = true;
        log?.warn(`worker: personal workspace refused (${errorMessage(cause)}); using project "${alt.project.name}" on ${host.name}`);
      }
    }
    const alt = fallback();
    if (alt === null) {
      throw new Error(`no project available to run capture on host "${host.name}"${personal === undefined ? " (no personal project)" : ""}`);
    }
    const thread = await sdk.threads.spawn({
      ...base,
      projectId: alt.project.id,
      environment: { type: "host", hostId: host.id, workspace: { type: "unmanaged", path: alt.path } },
    });
    return thread.id;
  }

  /** Throws "permission needed: <what>" when the thread is blocked on a pending interaction. */
  async function failIfPermissionPending(threadId: string): Promise<void> {
    let pending: ReadonlyArray<PendingLike>;
    try {
      pending = await sdk.threads.interactions.list({ threadId });
    } catch {
      return;
    }
    const blocked = pending.find((p) => p.status === "pending");
    if (blocked !== undefined) throw new Error(`permission needed: ${describePending(blocked)}`);
  }

  async function runOn(host: Host, request: WorkerRequest): Promise<string> {
    const threadId = await spawn(host, request);
    const deadline = Date.now() + request.timeoutMs;
    try {
      for (;;) {
        const remaining = deadline - Date.now();
        const slice = Math.max(1, Math.min(pollMs, remaining));
        let idle = false;
        try {
          // May throw when the slice elapses without the thread going idle; that is the normal "not yet" path.
          await sdk.threads.wait({ threadId, status: "idle", timeoutMs: slice, pollIntervalMs: Math.min(500, slice) });
          idle = true;
        } catch {
          idle = false;
        }
        const current = await sdk.threads.get({ threadId });
        if (current.status === "error") throw new Error(`worker thread failed (${request.title})`);
        if (idle || current.status === "idle") {
          const { output } = await sdk.threads.output({ threadId });
          // A fresh thread can be idle before its turn starts: keep looping until there is text.
          if (output !== null && output.trim() !== "") return output;
        } else {
          await failIfPermissionPending(threadId);
        }
        if (Date.now() >= deadline) {
          await failIfPermissionPending(threadId);
          throw new Error(`worker timed out after ${Math.round(request.timeoutMs / 1000)}s (${request.title})`);
        }
        if (idle) await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
      }
    } finally {
      await sdk.threads.archive({ threadId }).catch((cause: unknown) => log?.warn(`worker: archive failed: ${errorMessage(cause)}`));
      await sdk.threads.stop({ threadId }).catch((cause: unknown) => log?.warn(`worker: stop failed: ${errorMessage(cause)}`));
    }
  }

  return {
    async run(request) {
      return runOn(await resolveHost(), request);
    },
    async ping() {
      let host: Host | undefined;
      try {
        host = await resolveHost();
        const cfg = settings();
        const reply = await runOn(host, {
          prompt: PING_PROMPT,
          title: `${THREAD_TITLE_PREFIX}ping`,
          model: cfg.captureModel === "" ? undefined : cfg.captureModel,
          timeoutMs: PING_TIMEOUT_MS,
          tools: "none",
        });
        return { ok: true, hostId: host.id, hostName: host.name, reply };
      } catch (cause) {
        return { ok: false, ...(host === undefined ? {} : { hostId: host.id, hostName: host.name }), error: errorMessage(cause) };
      }
    },
  };
}
