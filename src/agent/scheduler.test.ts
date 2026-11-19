import { describe, expect, test } from "bun:test";
import {
  MessageQueue,
  type NewQueuedMessage,
  openStateDb,
  type QueuedMessage,
} from "../state/index.ts";
import { Scheduler } from "./scheduler.ts";

const msg = (conversationKey: string, text = conversationKey): NewQueuedMessage => ({
  conversationKey,
  channel: "C1",
  ts: "1.0",
  threadTs: null,
  user: "U1",
  text,
});

/** A runner whose turns finish only when the test says so. */
function controllableRunner() {
  const started: string[] = [];
  const finishers = new Map<string, () => void>();
  const run = (m: QueuedMessage, shutdown: AbortSignal) =>
    new Promise<void>((resolve) => {
      started.push(m.text);
      finishers.set(m.text, resolve);
      shutdown.addEventListener("abort", () => resolve());
    });
  const finish = async (text: string) => {
    finishers.get(text)?.();
    await Bun.sleep(0);
  };
  return { run, started, finish };
}

function setup(maxConcurrent: number, maxQueue = 100) {
  const queue = new MessageQueue(openStateDb(":memory:"));
  const runner = controllableRunner();
  const scheduler = new Scheduler(queue, runner.run, { maxConcurrent, maxQueue });
  return { queue, scheduler, ...runner };
}

describe("Scheduler", () => {
  test("starts up to maxConcurrent turns, queues the rest in order", async () => {
    const { scheduler, started, finish } = setup(2);
    expect(scheduler.submit(msg("A"))).toEqual({ status: "started" });
    expect(scheduler.submit(msg("B"))).toEqual({ status: "started" });
    expect(scheduler.submit(msg("C"))).toEqual({ status: "queued", position: 1 });
    expect(scheduler.submit(msg("D"))).toEqual({ status: "queued", position: 2 });
    expect(started).toEqual(["A", "B"]);

    await finish("B");
    expect(started).toEqual(["A", "B", "C"]);
    expect(scheduler.runningCount).toBe(2);
  });

  test("runs one turn at a time per conversation", async () => {
    const { scheduler, started, finish } = setup(4);
    scheduler.submit(msg("A", "a1"));
    expect(scheduler.submit(msg("A", "a2"))).toEqual({ status: "queued", position: 1 });
    scheduler.submit(msg("B", "b1"));
    expect(started).toEqual(["a1", "b1"]);

    await finish("a1");
    expect(started).toEqual(["a1", "b1", "a2"]);
  });

  test("rejects when the queue is full", () => {
    const { scheduler } = setup(1, 2);
    scheduler.submit(msg("A"));
    scheduler.submit(msg("B"));
    scheduler.submit(msg("C"));
    expect(scheduler.submit(msg("D"))).toEqual({ status: "rejected" });
  });

  test("removes finished messages and survives a failing turn", async () => {
    const queue = new MessageQueue(openStateDb(":memory:"));
    const errors: string[] = [];
    const scheduler = new Scheduler(
      queue,
      async (m) => {
        if (m.text === "boom") throw new Error("boom");
      },
      { maxConcurrent: 1, maxQueue: 10, onError: (e) => errors.push((e as Error).message) },
    );
    scheduler.submit(msg("A", "boom"));
    scheduler.submit(msg("B", "ok"));
    await Bun.sleep(10);
    expect(errors).toEqual(["boom"]);
    expect(queue.pendingCount()).toBe(0);
    expect(queue.claimNext()).toBeNull();
  });

  test("retries failed cleanup and polling without re-running the finished turn", async () => {
    const queue = new MessageQueue(openStateDb(":memory:"));
    const remove = queue.remove.bind(queue);
    const claim = queue.claimNext.bind(queue);
    const errors: string[] = [];
    const { run, started, finish } = controllableRunner();
    const scheduler = new Scheduler(queue, run, {
      maxConcurrent: 1,
      maxQueue: 10,
      onQueueError: (_, operation) => errors.push(operation),
    });
    scheduler.submit(msg("A", "a1"));
    scheduler.submit(msg("A", "a2"));
    queue.remove = () => {
      throw new Error("remove unavailable");
    };
    queue.claimNext = () => {
      throw new Error("claim unavailable");
    };
    await finish("a1");
    expect(scheduler.runningCount).toBe(0);
    expect(errors).toEqual(["remove finished message #1", "claim next message"]);
    expect(queue.listPending().map((m) => m.text)).toEqual(["a2"]);

    queue.remove = remove;
    queue.claimNext = claim;
    scheduler.pump();
    expect(started).toEqual(["a1", "a2"]);
    await scheduler.stop();
  });

  test("shutdown retries finished-row cleanup even when no turn is running", async () => {
    const queue = new MessageQueue(openStateDb(":memory:"));
    const remove = queue.remove.bind(queue);
    const { run, finish, started } = controllableRunner();
    const scheduler = new Scheduler(queue, run, {
      maxConcurrent: 1,
      maxQueue: 10,
      onQueueError: () => {},
    });
    scheduler.submit(msg("A"));
    queue.remove = () => {
      throw new Error("remove unavailable");
    };
    await finish("A");
    expect(scheduler.runningCount).toBe(0);

    queue.remove = remove;
    await scheduler.stop();
    expect(queue.takeInterrupted()).toEqual([]);
    expect(started).toEqual(["A"]);
  });

  test("lists running turns and cancels one by conversation, with who did it", async () => {
    const queue = new MessageQueue(openStateDb(":memory:"));
    const reasons: unknown[] = [];
    const scheduler = new Scheduler(
      queue,
      (_m, signal) =>
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => {
            reasons.push(signal.reason);
            resolve();
          }),
        ),
      { maxConcurrent: 2, maxQueue: 10, now: () => 1_000 },
    );
    scheduler.submit(msg("A"));
    scheduler.submit(msg("B"));
    expect(scheduler.runningTurns().map((t) => [t.message.conversationKey, t.startedAt])).toEqual([
      ["A", 1_000],
      ["B", 1_000],
    ]);
    expect(scheduler.cancel("A", "U_ADMIN")).toBe(true);
    expect(scheduler.cancel("nope", "U_ADMIN")).toBe(false);
    await Bun.sleep(0);
    expect(reasons).toEqual([{ kind: "cancelled", by: "U_ADMIN" }]);
    expect(scheduler.runningTurns().map((t) => t.message.conversationKey)).toEqual(["B"]);
    await scheduler.stop();
  });

  test("stop aborts running turns and refuses new work", async () => {
    const { scheduler, started } = setup(1);
    scheduler.submit(msg("A"));
    scheduler.submit(msg("B"));
    await scheduler.stop();
    expect(started).toEqual(["A"]);
    expect(scheduler.runningCount).toBe(0);
    expect(scheduler.submit(msg("C"))).toEqual({ status: "rejected" });
  });

  test("direct messages run before passive ones", async () => {
    const { scheduler, started, finish } = setup(1);
    scheduler.submit(msg("busy"));
    scheduler.submit({ ...msg("P"), mode: "passive" });
    scheduler.submit(msg("D"));
    await finish("busy");
    expect(started).toEqual(["busy", "D"]);
    await finish("D");
    expect(started).toEqual(["busy", "D", "P"]);
  });

  test("a direct message stops a passive turn in its conversation (superseded)", async () => {
    const queue = new MessageQueue(openStateDb(":memory:"));
    const reasons: unknown[] = [];
    const scheduler = new Scheduler(
      queue,
      (_m, signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            reasons.push(signal.reason);
            resolve();
          });
        }),
      { maxConcurrent: 4, maxQueue: 10 },
    );
    scheduler.submit({ ...msg("T"), mode: "passive" });
    scheduler.submit({ ...msg("other"), mode: "passive" });
    scheduler.submit(msg("T", "mention"));
    await Bun.sleep(0);
    expect(reasons).toEqual([{ kind: "superseded" }]); // only T's passive turn
    expect(scheduler.runningTurns().map((t) => t.message.text)).toEqual(["other", "mention"]);
    await scheduler.stop();
  });
});
