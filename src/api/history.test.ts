import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rolloutEvents, threadHistory, threadItem } from "./history.ts";

const T0 = Date.parse("2026-11-18T14:40:00.000Z");
let clock = 0;
/** One rollout line, a second after the previous one. */
const line = (type: string, payload: object) =>
  JSON.stringify({ timestamp: new Date(T0 + clock++ * 1000).toISOString(), type, payload });
const event = (type: string, rest: object = {}) => line("event_msg", { type, ...rest });
const item = (body: object) => event("item_completed", { item: body });
const said = (text: string) =>
  item({ type: "UserMessage", id: "u", content: [{ type: "text", text }] });
const answered = (id: string, text: string) =>
  item({ type: "AgentMessage", id, content: [{ type: "Text", text }] });

const FINAL = JSON.stringify({
  reply: true,
  message: "All **done**.",
  choices: ["Ship"],
  files: ["out/report.pdf"],
});

function rollout(): string {
  clock = 0;
  return [
    line("session_meta", { id: "thread" }),
    event("task_started", { turn_id: "t1" }),
    line("response_item", { type: "message", role: "user", content: [] }),
    said("<@web>: fix the bug"),
    item({ type: "Reasoning", id: "r0", summary_text: [], raw_content: [] }),
    item({ type: "Reasoning", id: "r1", summary_text: ["Look at the test", "Then fix it"] }),
    item({
      type: "CommandExecution",
      id: "c1",
      command: ["/bin/zsh", "-lc", "bun test"],
      aggregated_output: "1 fail\n",
      exit_code: 1,
      status: "failed",
    }),
    item({
      type: "FileChange",
      id: "f1",
      changes: { "/w/a.ts": { type: "update" }, "/w/b.ts": { type: "add", content: "x" } },
      status: "completed",
    }),
    item({
      type: "McpToolCall",
      id: "m1",
      server: "elseagent",
      tool: "todo_list",
      arguments: { status: "active" },
      status: "completed",
      result: { content: [{ type: "text", text: "[]" }], structuredContent: { todos: [] } },
    }),
    item({ type: "Extension", kind: "web.search", id: "w1", query: "bun sse" }),
    item({ type: "Extension", kind: "something.else", id: "x1" }),
    item({ type: "Mystery", id: "x2" }),
    answered("a1", FINAL),
    event("token_count", {}),
    event("task_complete", { turn_id: "t1", last_agent_message: FINAL }),
    event("task_started", { turn_id: "t2" }),
    said("<@web>: and now?"),
    event("turn_aborted", { turn_id: "t2", reason: "interrupted" }),
    event("task_started", { turn_id: "t3" }),
    said("Run the nightly check"),
    answered("a3", "working on it"),
    '{"timestamp": "2026-11-18T14:4', // a line still being written
  ].join("\n");
}

describe("rolloutEvents", () => {
  test("turns a rollout into the events of a live turn", () => {
    const events = rolloutEvents(rollout());
    expect(events.map((e) => `${e.messageId}:${e.type}`)).toEqual([
      "t1:user_message",
      "t1:turn_started",
      ...Array(6).fill("t1:codex"),
      "t1:reply",
      "t1:turn_ended",
      "t2:user_message",
      "t2:turn_started",
      "t2:turn_ended",
      "t3:user_message",
      "t3:turn_started",
      "t3:codex",
      "t3:turn_ended",
    ]);
    expect(events[0]).toEqual({
      type: "user_message",
      text: "fix the bug",
      user: "web",
      messageId: "t1",
      at: T0 + 3000,
    });
    const items = events.flatMap((e) =>
      e.type === "codex" && e.event.type === "item.completed" ? [e.event.item] : [],
    );
    expect(items.slice(0, 5)).toEqual([
      { id: "r1", type: "reasoning", text: "Look at the test\nThen fix it" },
      {
        id: "c1",
        type: "command_execution",
        command: "/bin/zsh -lc 'bun test'",
        aggregated_output: "1 fail\n",
        exit_code: 1,
        status: "failed",
      },
      {
        id: "f1",
        type: "file_change",
        changes: [
          { path: "/w/a.ts", kind: "update" },
          { path: "/w/b.ts", kind: "add" },
        ],
        status: "completed",
      },
      {
        id: "m1",
        type: "mcp_tool_call",
        server: "elseagent",
        tool: "todo_list",
        arguments: { status: "active" },
        result: { content: [{ type: "text", text: "[]" }], structured_content: { todos: [] } },
        status: "completed",
      },
      { id: "w1", type: "web_search", query: "bun sse" },
    ]);
    expect(events.find((e) => e.type === "reply")).toMatchObject({
      text: "All **done**.",
      choices: ["Ship"],
      files: [{ name: "report.pdf", path: "out/report.pdf" }],
    });
    const ended = events.flatMap((e) => (e.type === "turn_ended" ? [e.status] : []));
    expect(ended).toEqual(["completed", "interrupted", "interrupted"]);
    // A scheduled run's prompt is not addressed by anyone.
    expect(events.find((e) => e.messageId === "t3")).toMatchObject({
      text: "Run the nightly check",
      user: "",
    });
  });

  test("leaves out turns that started at or after `before`", () => {
    const text = rollout();
    const t2 = rolloutEvents(text).find((e) => e.messageId === "t2")?.at ?? 0;
    const ids = (before: number) => [
      ...new Set(rolloutEvents(text, { before }).map((e) => e.messageId)),
    ];
    // `at` of t2's first event is its user message, one line after `task_started`.
    expect(ids(t2 - 1000)).toEqual(["t1"]);
    expect(ids(t2)).toEqual(["t1", "t2"]);
    expect(ids(T0)).toEqual([]);
  });

  test("a silent turn has no reply, and odd input is skipped", () => {
    clock = 0;
    const silent = JSON.stringify({ reply: false, message: "", choices: [], files: [] });
    const events = rolloutEvents(
      [
        "not json",
        "[]",
        event("item_completed", { item: { type: "AgentMessage", id: "stray", content: [] } }),
        event("task_started", { turn_id: "t1" }),
        event("item_completed", {}),
        event("task_complete", { turn_id: "t1", last_agent_message: silent }),
        event("task_started", { turn_id: "t2" }),
        event("task_complete", { turn_id: "t2", last_agent_message: null }),
      ].join("\n"),
    );
    expect(events.map((e) => `${e.messageId}:${e.type}`)).toEqual([
      "t1:turn_started",
      "t1:turn_ended",
      "t2:turn_started",
      "t2:turn_ended",
    ]);
    expect(rolloutEvents("")).toEqual([]);
  });

  test("threadItem writes a command the way a live event does", () => {
    const command = ["/bin/zsh", "-lc", "printf '%s\\n' \"$HOME\" > a.txt"];
    expect(threadItem({ type: "CommandExecution", id: "c", command })).toEqual({
      id: "c",
      type: "command_execution",
      command: `/bin/zsh -lc "printf '%s\\\\n' \\"\\$HOME\\" > a.txt"`,
      aggregated_output: "",
      status: "completed",
    });
    expect(threadItem({ type: "CommandExecution", id: "c", command: "git status" })).toMatchObject({
      command: "git status",
    });
    expect(
      threadItem({
        type: "McpToolCall",
        id: "m",
        server: "s",
        tool: "t",
        error: { message: "no" },
      }),
    ).toMatchObject({ error: { message: "no" }, status: "completed" });
  });
});

describe("threadHistory", () => {
  const home = mkdtempSync(join(tmpdir(), "elseagent-history-"));
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  const first = "01a1ef1a-63df-7ba0-a3b0-550e06b452f4";
  const second = "01a1ef1a-63df-7ba0-a3b0-550e06b452f5";
  const gone = "01a1ef1a-63df-7ba0-a3b0-550e06b452f6";

  test("reads each thread's rollout in order, skipping ones Codex no longer has", async () => {
    const turnOf = (id: string) =>
      [event("task_started", { turn_id: id }), event("task_complete", { turn_id: id })].join("\n");
    await Bun.write(
      join(home, "sessions/2026/11/18", `rollout-2026-11-18T14-40-48-${first}.jsonl`),
      turnOf("a"),
    );
    await Bun.write(
      join(home, "archived_sessions", `rollout-2026-11-19T09-00-00-${second}.jsonl`),
      turnOf("b"),
    );
    const events = await threadHistory([first, gone, "not-a-thread-id", second], { home });
    expect(events.map((e) => `${e.messageId}:${e.type}`)).toEqual([
      "a:turn_started",
      "a:turn_ended",
      "b:turn_started",
      "b:turn_ended",
    ]);
    expect(await threadHistory([], { home })).toEqual([]);
  });
});
