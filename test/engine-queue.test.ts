import { describe, expect, it } from "vitest";
import { createSerialQueue } from "../lib/engine/queue";

const gate = () => {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("serial queue", () => {
  it("runs tasks one at a time in order and reports status", async () => {
    const q = createSerialQueue();
    const order: string[] = [];
    const g = gate();
    const a = q.enqueue("day:1", async (setStep) => { setStep("capturing"); order.push("a-start"); await g.promise; order.push("a-end"); });
    const b = q.enqueue("day:2", async () => { order.push("b"); });
    await tick();
    expect(q.status().running).toMatchObject({ key: "day:1", step: "capturing" });
    expect(q.status().queued).toEqual(["day:2"]);
    expect(order).toEqual(["a-start"]);
    g.open();
    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "a-end", "b"]);
    expect(q.status()).toMatchObject({ running: null, queued: [] });
  });

  it("joins a second request for the same key", async () => {
    const q = createSerialQueue();
    let runs = 0;
    const g = gate();
    const task = async () => { runs += 1; await g.promise; };
    const a = q.enqueue("week:x", task);
    const b = q.enqueue("week:x", task);
    expect(a).toBe(b);
    g.open();
    await a;
    expect(runs).toBe(1);
    await q.enqueue("week:x", task);
    expect(runs).toBe(2);
  });

  it("a failure sets lastError, does not block the next task, and clears on later success", async () => {
    const q = createSerialQueue(undefined, () => new Date("2026-11-13T12:00:00Z"));
    const failing = q.enqueue("week:a", async () => { throw new Error("boom"); });
    const next = q.enqueue("week:b", async () => undefined);
    await expect(failing).rejects.toThrow("boom");
    await next;
    expect(q.status().lastError).toEqual({ key: "week:a", message: "boom", at: "2026-11-13T12:00:00.000Z" });
    await q.enqueue("week:a", async () => undefined);
    expect(q.status().lastError).toBeNull();
  });

  it("notifies on changes", async () => {
    let n = 0;
    const q = createSerialQueue(() => { n += 1; });
    await q.enqueue("k", async (s) => s("x"));
    expect(n).toBeGreaterThanOrEqual(3);
  });
});

describe("serial queue: afterRunning", () => {
  it("reports state and queues a fresh run behind a running one", async () => {
    const q = createSerialQueue();
    const g = gate();
    const order: string[] = [];
    const first = q.enqueue("week:x", async () => { order.push("first"); await g.promise; });
    await new Promise((r) => setTimeout(r, 0));
    expect(q.state("week:x")).toBe("running");
    expect(q.enqueue("week:x", async () => undefined)).toBe(first); // plain join
    const second = q.enqueue("week:x", async () => { order.push("second"); }, { afterRunning: true });
    expect(second).not.toBe(first);
    expect(q.state("week:x")).toBe("waiting"); // the key now points at the queued rerun
    expect(q.status().queued).toEqual(["week:x"]);
    g.open();
    await second;
    expect(order).toEqual(["first", "second"]);
    expect(q.state("week:x")).toBe("idle");
  });
});
