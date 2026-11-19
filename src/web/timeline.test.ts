import { describe, expect, test } from "bun:test";
import type { ThreadItem } from "@openai/codex-sdk";
import type { SessionEvent, SessionEventBody } from "../api/events.ts";
import { buildTimeline, groupByDay, groupSteps, summarizeSteps } from "./timeline.ts";

const at = (messageId: string, body: SessionEventBody): SessionEvent => ({
  ...body,
  messageId,
  at: 0,
});
const item = (messageId: string, type: "item.started" | "item.completed", it: ThreadItem) =>
  at(messageId, { type: "codex", event: { type, item: it } });
const command = (status: "in_progress" | "completed"): ThreadItem => ({
  id: "c1",
  type: "command_execution",
  command: "ls",
  aggregated_output: status === "completed" ? "a.txt\n" : "",
  status,
});
const FINAL = JSON.stringify({ reply: true, message: "Done.", choices: [], files: [] });

const turn: SessionEvent[] = [
  at("m1", { type: "user_message", text: "list files", user: "web" }),
  at("m1", { type: "turn_started" }),
  at("m1", { type: "status", text: "is thinking…" }),
  at("m1", { type: "codex", event: { type: "turn.started" } }),
  item("m1", "item.completed", { id: "r0", type: "reasoning", text: " " }),
  item("m1", "item.completed", { id: "a0", type: "agent_message", text: "Looking." }),
  item("m1", "item.started", command("in_progress")),
  at("m1", { type: "status", text: "is running `ls`…" }),
];
const finished: SessionEvent[] = [
  ...turn,
  item("m1", "item.completed", command("completed")),
  item("m1", "item.completed", { id: "a1", type: "agent_message", text: FINAL }),
  at("m1", {
    type: "reply",
    text: "Done.",
    choices: ["More"],
    files: [{ name: "a.txt", path: "/w/a.txt" }],
  }),
  at("m1", { type: "turn_ended", status: "completed" }),
];

describe("buildTimeline", () => {
  test("a turn in progress shows its steps and what the agent is doing", () => {
    const timeline = buildTimeline(turn);
    expect(timeline.busy).toBe(true);
    expect(timeline.status).toBe("is running `ls`…");
    expect(timeline.entries.map((e) => e.kind)).toEqual(["user", "item", "item"]);
    expect(timeline.entries[2]).toMatchObject({ done: false, item: { status: "in_progress" } });
  });

  test("an item's later events update it in place; the JSON reply is not shown twice", () => {
    const timeline = buildTimeline(finished);
    expect(timeline).toMatchObject({ busy: false, status: "" });
    expect(timeline.entries.map((e) => e.kind)).toEqual(["user", "item", "item", "reply"]);
    expect(timeline.entries[2]).toMatchObject({
      done: true,
      item: { aggregated_output: "a.txt\n" },
    });
    expect(timeline.entries[3]).toMatchObject({
      text: "Done.",
      choices: ["More"],
      files: ["/w/a.txt"],
    });
  });

  test("a turn that did not complete says how it ended, and a queued one keeps it busy", () => {
    const timeline = buildTimeline([
      ...turn,
      at("m1", { type: "turn_ended", status: "interrupted" }),
      at("m2", { type: "user_message", text: "next", user: "web" }),
    ]);
    expect(timeline.entries.map((e) => e.kind)).toEqual(["user", "item", "item", "ended", "user"]);
    expect(timeline).toMatchObject({ busy: true, status: "" });
    expect(buildTimeline([])).toEqual({ entries: [], status: "", busy: false });
  });
});

describe("groupSteps", () => {
  test("folds consecutive steps into one block; only the last is active while busy", () => {
    const running = buildTimeline(turn);
    expect(groupSteps(running.entries, running.busy)).toMatchObject([
      { kind: "user" },
      { kind: "steps", active: true, steps: [{ kind: "item" }, { kind: "item" }] },
    ]);
    const done = buildTimeline(finished);
    expect(
      groupSteps(done.entries, done.busy).map((b) => [b.kind, "active" in b && b.active]),
    ).toEqual([
      ["user", false],
      ["steps", false],
      ["reply", false],
    ]);
  });

  test("summarizes what a block did", () => {
    const steps = (items: ThreadItem[]) =>
      items.map((it, i) => ({ kind: "item" as const, key: `${i}`, item: it, done: true }));
    expect(
      summarizeSteps(
        steps([
          command("completed"),
          command("completed"),
          { id: "f", type: "file_change", changes: [], status: "completed" },
          { id: "w", type: "web_search", query: "q" },
        ]),
      ),
    ).toBe("Ran 2 commands · made 1 edit · searched 1 time");
    expect(summarizeSteps(steps([{ id: "r", type: "reasoning", text: "hm" }]))).toBe("1 step");
  });
});

test("groupByDay puts sessions under when they were last active", () => {
  const now = new Date(2026, 10, 19, 15).getTime();
  const hours = (n: number) => ({ updatedAt: now - n * 3_600_000 });
  expect(
    groupByDay([hours(1), hours(14), hours(20), hours(24 * 3), hours(24 * 30)], now).map((g) => [
      g.label,
      g.sessions.length,
    ]),
  ).toEqual([
    ["Today", 2],
    ["Yesterday", 1],
    ["Previous 7 days", 1],
    ["Older", 1],
  ]);
  expect(groupByDay([], now)).toEqual([]);
});
