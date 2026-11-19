import { describe, expect, test } from "bun:test";
import { MessageQueue, openStateDb, ScheduleStore } from "../state/index.ts";
import { Scheduler } from "./scheduler.ts";
import { MAX_SCHEDULES, ScheduleRunner } from "./schedules.ts";

const at = (iso: string) => Date.parse(iso);

function setup(start: string) {
  let now = at(start);
  const db = openStateDb(":memory:");
  const store = new ScheduleStore(db, () => now);
  const queue = new MessageQueue(db);
  const scheduler = new Scheduler(queue, async () => {}, { maxConcurrent: 0, maxQueue: 1_000 });
  const runner = new ScheduleRunner(store, scheduler, () => now);
  const input = {
    name: "Daily CI",
    cron: "0 9 * * *",
    timezone: "UTC",
    channel: "C_OPS",
    prompt: "Check CI and summarize failures.",
    createdBy: "U1",
  };
  return {
    store,
    runner,
    queue,
    scheduler,
    input,
    setNow: (iso: string) => {
      now = at(iso);
    },
  };
}

describe("ScheduleRunner", () => {
  test("queues a run when due, as a scheduled message, and moves to the next time", () => {
    const { runner, store, queue, input, setNow } = setup("2026-11-14T08:00:00Z");
    const s = runner.create(input);
    expect(s.nextRunAt).toBe(at("2026-11-14T09:00:00Z"));

    expect(runner.tick()).toBe(0);
    setNow("2026-11-14T09:00:10Z");
    expect(runner.tick()).toBe(1);
    expect(queue.listPending()[0]).toMatchObject({
      channel: "C_OPS",
      ts: "",
      threadTs: null,
      user: "U1",
      scheduleId: s.id,
    });
    expect(queue.listPending()[0]?.text).toContain("Check CI and summarize failures.");
    expect(store.get(s.id)?.nextRunAt).toBe(at("2026-11-15T09:00:00Z"));
    expect(runner.tick()).toBe(0); // not due again until tomorrow
  });

  test("after downtime, a schedule that missed several runs runs once", () => {
    const { runner, store, queue, input, setNow } = setup("2026-11-14T08:00:00Z");
    const s = runner.create(input);
    setNow("2026-11-17T12:00:00Z"); // missed 3 runs
    expect(runner.tick()).toBe(1);
    expect(queue.listPending()).toHaveLength(1);
    expect(store.get(s.id)?.nextRunAt).toBe(at("2026-11-18T09:00:00Z"));
  });

  test("each run is its own conversation", () => {
    const { runner, store, queue, input, setNow } = setup("2026-11-14T08:00:00Z");
    const s = runner.create(input);
    runner.runNow(s);
    setNow("2026-11-14T08:00:01Z");
    runner.runNow(store.get(s.id) ?? s);
    expect(new Set(queue.listPending().map((m) => m.conversationKey)).size).toBe(2);
  });

  test("a full queue skips the run but still advances the schedule", () => {
    const { runner, store, input, setNow } = setup("2026-11-14T08:00:00Z");
    const s = runner.create(input);
    setNow("2026-11-14T09:00:10Z");
    for (let i = 0; i < 1_000; i++) runner.runNow(s);
    const errors: string[] = [];
    expect(runner.tick((_, e) => errors.push((e as Error).message))).toBe(0);
    expect(errors[0]).toContain("queue is full");
    expect(store.get(s.id)?.lastSkippedAt).toBe(s.nextRunAt);
    expect(store.get(s.id)?.lastRunAt).toBeNull();
    expect(store.get(s.id)?.nextRunAt).toBe(at("2026-11-15T09:00:00Z"));
  });

  test("rolls back an occurrence and its queued row together, then retries", () => {
    const { runner, queue, store, scheduler, input, setNow } = setup("2026-11-14T08:00:00Z");
    const s = runner.create(input);
    setNow("2026-11-14T09:00:10Z");
    const enqueue = scheduler.enqueue.bind(scheduler);
    scheduler.enqueue = (message) => {
      enqueue(message);
      throw new Error("failed after insert");
    };

    expect(runner.tick()).toBe(0);
    expect(queue.listPending()).toHaveLength(0);
    expect(store.get(s.id)?.nextRunAt).toBe(s.nextRunAt);

    scheduler.enqueue = enqueue;
    expect(runner.tick()).toBe(1);
    expect(runner.tick()).toBe(0);
    expect(queue.listPending().map((m) => m.conversationKey)).toEqual([
      `schedule:${s.id}:${s.nextRunAt}`,
    ]);
  });

  test("runs an overdue one-time schedule once and keeps its history", () => {
    const { runner, queue, store, input, setNow } = setup("2026-11-14T08:00:00Z");
    const { cron, ...oneTime } = input;
    const s = runner.create({ ...oneTime, at: "2026-11-14T18:00:00+08:00" });
    expect(s.nextRunAt).toBe(at("2026-11-14T10:00:00Z"));
    expect(runner.tick()).toBe(0);
    setNow("2026-11-17T12:00:00Z");
    expect(runner.tick()).toBe(1);
    expect(runner.tick()).toBe(0);
    expect(queue.listPending()).toHaveLength(1);
    expect(store.get(s.id)).toMatchObject({
      cron: null,
      nextRunAt: null,
      lastRunAt: at("2026-11-17T12:00:00Z"),
    });
    expect(store.count()).toBe(0);
  });

  test("requires exactly one timing option and an explicit offset for at", () => {
    const { runner, input } = setup("2026-11-14T08:00:00Z");
    const { cron, ...oneTime } = input;
    expect(() => runner.create(oneTime)).toThrow("exactly one");
    expect(() => runner.create({ ...input, at: "2026-11-15T09:00Z" })).toThrow("exactly one");
    expect(() => runner.create({ ...oneTime, at: "2026-11-15T09:00" })).toThrow("UTC offset");
    expect(() => runner.create({ ...oneTime, at: "2026-11-13T09:00Z" })).toThrow("future");
  });

  test("limits the number of schedules", () => {
    const { runner, input } = setup("2026-11-14T08:00:00Z");
    for (let i = 0; i < MAX_SCHEDULES; i++) runner.create(input);
    expect(() => runner.create(input)).toThrow("already has");
  });
});
