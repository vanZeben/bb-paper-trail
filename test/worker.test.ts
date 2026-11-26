import { describe, expect, it } from "vitest";
import { createWorker, permissionModeFor, type PendingLike, type SpawnArgs, type WorkerSdk } from "../lib/worker";
import { DEFAULT_SETTINGS, type Settings } from "../lib/settings";
import { THREAD_TITLE_PREFIX } from "../lib/meta";

interface FakeOpts {
  hosts?: Array<{ id: string; name: string; status: string }>;
  primaryHostId?: string | null;
  projects?: Array<{ id: string; kind: string; name: string; sources: Array<{ hostId: string; path: string }> }>;
  /** Per output() call; the last entry repeats. */
  outputs?: Array<string | null>;
  /** Per get() call; the last entry repeats. */
  statuses?: string[];
  /** Whether wait() resolves (thread idle) or throws (timeout) per call; the last entry repeats. */
  waits?: boolean[];
  pending?: PendingLike[];
  spawnFailsFirstWithPersonal?: boolean;
}

function fake(o: FakeOpts = {}) {
  const calls: string[] = [];
  const spawned: SpawnArgs[] = [];
  const hosts = o.hosts ?? [
    { id: "h1", name: "Laptop", status: "connected" },
    { id: "h2", name: "Server", status: "connected" },
  ];
  const outputs = [...(o.outputs ?? ['{"ok":true}'])];
  const statuses = [...(o.statuses ?? ["idle"])];
  const waits = [...(o.waits ?? [true])];
  const next = <T>(arr: T[]): T => (arr.length > 1 ? arr.shift()! : arr[0]!);
  const sdk: WorkerSdk = {
    hosts: { list: async () => hosts },
    system: { config: async () => ({ primaryHostId: o.primaryHostId === undefined ? "h1" : o.primaryHostId }) },
    projects: {
      list: async () => o.projects ?? [{ id: "p-personal", kind: "personal", name: "Personal", sources: [] }],
    },
    threads: {
      spawn: async (args) => {
        calls.push("spawn");
        spawned.push(args);
        if (o.spawnFailsFirstWithPersonal && args.environment.workspace.type === "personal") throw new Error("personal workspace not allowed");
        return { id: "t1" };
      },
      get: async () => ({ status: next(statuses) }),
      wait: async () => {
        calls.push("wait");
        if (!next(waits)) throw new Error("timed out");
        return {};
      },
      output: async () => {
        calls.push("output");
        return { output: next(outputs) };
      },
      interactions: {
        list: async () => {
          calls.push("interactions");
          return o.pending ?? [];
        },
      },
      archive: async () => void calls.push("archive"),
      stop: async () => void calls.push("stop"),
    },
  };
  return { sdk, calls, spawned };
}

const settings = (patch: Partial<Settings> = {}) => () => ({ ...DEFAULT_SETTINGS, ...patch });
const req = { prompt: "do it", title: `${THREAD_TITLE_PREFIX}day-capture`, timeoutMs: 5000 };

describe("worker", () => {
  it("happy path: spawns a hidden personal-workspace thread on the primary host, returns the output, archives then stops", async () => {
    const f = fake();
    const worker = createWorker({ sdk: f.sdk, settings: settings({ workerPermissionMode: "accept-edits", providerId: "prov" }), pollMs: 5 });
    const out = await worker.run({ ...req, model: "small" });
    expect(out).toBe('{"ok":true}');
    expect(f.spawned).toHaveLength(1);
    expect(f.spawned[0]).toMatchObject({
      projectId: "p-personal",
      prompt: "do it",
      title: req.title,
      visibility: "hidden",
      permissionMode: "accept-edits",
      model: "small",
      providerId: "prov",
      pluginMetadata: { job: "day-capture" },
      environment: { type: "host", hostId: "h1", workspace: { type: "personal" } },
    });
    expect(f.calls.slice(-2)).toEqual(["archive", "stop"]);
  });

  it("omits model and providerId when empty", async () => {
    const f = fake();
    await createWorker({ sdk: f.sdk, settings: settings(), pollMs: 5 }).run({ ...req, model: "" });
    expect(f.spawned[0]).not.toHaveProperty("model");
    expect(f.spawned[0]).not.toHaveProperty("providerId");
  });

  it("loops while the thread is idle with null or blank output, then returns the text", async () => {
    const f = fake({ outputs: [null, "  ", "  hello  "] });
    const out = await createWorker({ sdk: f.sdk, settings: settings(), pollMs: 5 }).run(req);
    expect(out).toBe("  hello  ");
    expect(f.calls.filter((c) => c === "output")).toHaveLength(3);
    expect(f.calls.slice(-2)).toEqual(["archive", "stop"]);
  });

  it("a wait timeout while still active keeps polling until the thread goes idle", async () => {
    const f = fake({ waits: [false, false, true], statuses: ["active", "active", "idle"] });
    expect(await createWorker({ sdk: f.sdk, settings: settings(), pollMs: 5 }).run(req)).toBe('{"ok":true}');
  });

  it("fails fast with 'permission needed' when a pending interaction blocks the thread, and still archives and stops", async () => {
    const f = fake({ waits: [false], statuses: ["active"], pending: [{ status: "pending", payload: { kind: "x/y", title: "Run shell command: gh pr list" } }] });
    const worker = createWorker({ sdk: f.sdk, settings: settings(), pollMs: 5 });
    const started = Date.now();
    await expect(worker.run({ ...req, timeoutMs: 60_000 })).rejects.toThrow("permission needed: Run shell command: gh pr list");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(f.calls.slice(-2)).toEqual(["archive", "stop"]);
  });

  it("ignores resolved interactions and times out with a clear error", async () => {
    const f = fake({ waits: [false], statuses: ["active"], pending: [{ status: "resolved" }] });
    const worker = createWorker({ sdk: f.sdk, settings: settings(), pollMs: 5 });
    await expect(worker.run({ ...req, timeoutMs: 40 })).rejects.toThrow(/worker timed out after 0s|worker timed out/);
    expect(f.calls.slice(-2)).toEqual(["archive", "stop"]);
  });

  it("an errored thread throws and is still cleaned up", async () => {
    const f = fake({ waits: [false], statuses: ["error"] });
    await expect(createWorker({ sdk: f.sdk, settings: settings(), pollMs: 5 }).run(req)).rejects.toThrow("worker thread failed");
    expect(f.calls.slice(-2)).toEqual(["archive", "stop"]);
  });

  it("archive and stop failures never mask the result", async () => {
    const f = fake();
    f.sdk.threads.archive = async () => {
      throw new Error("boom");
    };
    expect(await createWorker({ sdk: f.sdk, settings: settings(), pollMs: 5 }).run(req)).toBe('{"ok":true}');
    expect(f.calls).toContain("stop");
  });

  describe("host resolution", () => {
    it("matches captureHost by machine name, case-insensitively", async () => {
      const f = fake();
      await createWorker({ sdk: f.sdk, settings: settings({ captureHost: " server " }), pollMs: 5 }).run(req);
      expect(f.spawned[0]!.environment.hostId).toBe("h2");
    });

    it("throws a plain error when the named host is missing, without spawning", async () => {
      const f = fake();
      await expect(createWorker({ sdk: f.sdk, settings: settings({ captureHost: "Nope" }) }).run(req)).rejects.toThrow(/capture host "Nope" not found.*Laptop, Server/);
      expect(f.calls).toEqual([]);
    });

    it("throws when the named host is disconnected", async () => {
      const f = fake({ hosts: [{ id: "h2", name: "Server", status: "disconnected" }] });
      await expect(createWorker({ sdk: f.sdk, settings: settings({ captureHost: "Server" }) }).run(req)).rejects.toThrow('capture host "Server" is disconnected');
      expect(f.calls).toEqual([]);
    });

    it("throws when the primary host is disconnected", async () => {
      const f = fake({ hosts: [{ id: "h1", name: "Laptop", status: "disconnected" }] });
      await expect(createWorker({ sdk: f.sdk, settings: settings() }).run(req)).rejects.toThrow("disconnected");
    });

    it("falls back to the first connected host when there is no primary", async () => {
      const f = fake({ primaryHostId: null, hosts: [{ id: "h1", name: "A", status: "disconnected" }, { id: "h2", name: "B", status: "connected" }] });
      await createWorker({ sdk: f.sdk, settings: settings(), pollMs: 5 }).run(req);
      expect(f.spawned[0]!.environment.hostId).toBe("h2");
    });

    it("throws when no host is connected", async () => {
      const f = fake({ primaryHostId: null, hosts: [] });
      await expect(createWorker({ sdk: f.sdk, settings: settings() }).run(req)).rejects.toThrow("no connected bb host");
    });
  });

  describe("environment fallback", () => {
    it("uses a standard project's local path on the host when the personal workspace is refused, and remembers it", async () => {
      const f = fake({
        spawnFailsFirstWithPersonal: true,
        projects: [
          { id: "p-personal", kind: "personal", name: "Personal", sources: [] },
          { id: "p-std", kind: "standard", name: "Scratch", sources: [{ hostId: "h1", path: "/work/scratch" }] },
        ],
      });
      const warnings: string[] = [];
      const worker = createWorker({ sdk: f.sdk, settings: settings(), pollMs: 5, log: { info: () => undefined, warn: (m) => void warnings.push(m) } });
      await worker.run(req);
      await worker.run(req);
      expect(f.spawned.map((s) => s.environment.workspace)).toEqual([{ type: "personal" }, { type: "unmanaged", path: "/work/scratch" }, { type: "unmanaged", path: "/work/scratch" }]);
      expect(f.spawned[1]!.projectId).toBe("p-std");
      expect(warnings).toHaveLength(1);
    });

    it("rethrows the spawn error when no fallback project exists", async () => {
      const f = fake({ spawnFailsFirstWithPersonal: true });
      await expect(createWorker({ sdk: f.sdk, settings: settings() }).run(req)).rejects.toThrow("personal workspace not allowed");
    });
  });

  describe("ping", () => {
    it("reports host and reply on success", async () => {
      const f = fake({ outputs: ['{"ok":true}'] });
      const res = await createWorker({ sdk: f.sdk, settings: settings({ captureModel: "small" }), pollMs: 5 }).ping();
      expect(res).toEqual({ ok: true, hostId: "h1", hostName: "Laptop", reply: '{"ok":true}' });
      expect(f.spawned[0]!.prompt).toBe('Reply with exactly: {"ok":true}');
      expect(f.spawned[0]!.model).toBe("small");
      expect(f.spawned[0]!.title).toBe(`${THREAD_TITLE_PREFIX}ping`);
      expect(f.calls.slice(-2)).toEqual(["archive", "stop"]);
    });

    it("never throws: host errors and worker errors come back as ok:false", async () => {
      const missing = await createWorker({ sdk: fake().sdk, settings: settings({ captureHost: "Nope" }) }).ping();
      expect(missing.ok).toBe(false);
      expect(missing.error).toContain("not found");
      expect(missing.hostId).toBeUndefined();

      const f = fake({ waits: [false], statuses: ["active"], pending: [{ status: "pending", payload: { title: "Allow gh" } }] });
      const blocked = await createWorker({ sdk: f.sdk, settings: settings(), pollMs: 5 }).ping();
      expect(blocked).toMatchObject({ ok: false, hostId: "h1", hostName: "Laptop", error: "permission needed: Allow gh" });
    });
  });
});

describe("worker permission mode", () => {
  it("maps tool-free jobs to the strictest mode and never uses full", async () => {
    expect(permissionModeFor("auto", "none")).toBe("accept-edits");
    expect(permissionModeFor("accept-edits", "read")).toBe("accept-edits");
    expect(permissionModeFor("auto", undefined)).toBe("auto");
    expect(permissionModeFor("full", "read")).toBe("auto");
    expect(permissionModeFor("full", undefined)).toBe("auto");
    expect(permissionModeFor("full", "none")).toBe("accept-edits");
  });

  it("spawns a tools:none job in accept-edits even when the setting is auto, and treats a stored full as auto", async () => {
    const none = fake();
    await createWorker({ sdk: none.sdk, settings: settings({ workerPermissionMode: "auto" }), pollMs: 5 }).run({ ...req, tools: "none" });
    expect(none.spawned[0]!.permissionMode).toBe("accept-edits");

    const read = fake();
    await createWorker({ sdk: read.sdk, settings: settings({ workerPermissionMode: "full" as unknown as Settings["workerPermissionMode"] }), pollMs: 5 }).run({ ...req, tools: "read" });
    expect(read.spawned[0]!.permissionMode).toBe("auto");

    const ping = fake();
    await createWorker({ sdk: ping.sdk, settings: settings(), pollMs: 5 }).ping();
    expect(ping.spawned[0]!.permissionMode).toBe("accept-edits");
  });
});
