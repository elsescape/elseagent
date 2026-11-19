import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Admin, type Caller } from "../agent/admin.ts";
import { Cleanup } from "../agent/cleanup.ts";
import type { RunningTurn } from "../agent/scheduler.ts";
import { ScheduleRunner } from "../agent/schedules.ts";
import { createSlackTools } from "../channels/slack/tools.ts";
import {
  MessageQueue,
  openStateDb,
  ScheduleStore,
  SessionStore,
  UsageStore,
} from "../state/index.ts";
import { MemoryStore } from "../state/memory.ts";
import { TodoStore } from "../state/todos.ts";
import { createMemoryTools } from "./memory-tools.ts";
import { type McpEndpoint, startMcpServer, TURN_HEADER } from "./server.ts";
import { createTodoTools } from "./todo-tools.ts";

// A running turn (id 1) in conversation C1:1.0, plus another one (id 2) that can be cancelled.
const turns: RunningTurn[] = [1, 2].map((id) => ({
  message: {
    id,
    conversationKey: `C1:${id}.0`,
    channel: "C1",
    ts: `${id}.0`,
    threadTs: `${id}.0`,
    user: `U${id}`,
    text: `message ${id}`,
    scheduleId: null,
    mode: "direct" as const,
    files: [],
  },
  startedAt: Date.now() - 65_000,
}));
const cancelled: [string, string][] = [];
const ensured: string[] = [];

const db = openStateDb(":memory:");
const queue = new MessageQueue(db);
const sessions = new SessionStore(db);
const schedules = new ScheduleStore(db);
const usage = new UsageStore(db);
const deletedThreads: string[] = [];
const scheduler = {
  runningTurns: () => turns,
  cancel: (key: string, by: string) => {
    cancelled.push([key, by]);
    return turns.some((t) => t.message.conversationKey === key);
  },
};
const admin = new Admin({
  scheduler,
  queue,
  sessions,
  schedules,
  scheduleRunner: new ScheduleRunner(schedules, {
    submit: () => ({ status: "started" }),
    enqueue: () => null,
    pump: () => {},
  }),
  usage,
  cleanup: new Cleanup({
    sessions,
    busyConversations: () => queue.conversations(),
    deleteThread: async (id) => void deletedThreads.push(id),
    workspace: mkdtempSync(join(tmpdir(), "elseagent-mcp-")),
  }),
  ensureChannel: async (ref) => {
    ensured.push(ref);
    if (ref === "#secret") throw new Error("I can't post in #secret; invite me there first");
    return "C_OPS";
  },
  limits: { maxConcurrent: 16, maxQueue: 1024, turnTimeoutMinutes: 30, sessionIdleDays: 7 },
  defaultTimezone: "UTC",
});

const slackChannel = "C1234567890";
const privateChannel = "C0987654321";
const slackHistory = [
  { ts: "2.0", text: "new", user: "U1", reply_count: 2 },
  { ts: "1.0", text: "old", user: "U2" },
];
const slackRequests: { method: string; payload: object | undefined }[] = [];
const registerSlackTools = createSlackTools(
  {
    conversations: {
      list: async () => ({ ok: true, channels: [{ id: slackChannel, name: "ops" }] }),
      info: async ({ channel }) => ({
        ok: true,
        channel: { is_channel: true, is_private: channel === privateChannel, is_member: true },
      }),
      history: async (payload) => {
        slackRequests.push({ method: "history", payload });
        return { ok: true, messages: slackHistory, response_metadata: { next_cursor: "older" } };
      },
      replies: async (payload) => {
        slackRequests.push({ method: "replies", payload });
        return { ok: true, messages: slackHistory.toReversed() };
      },
    },
    apiCall: async (method, payload) => {
      slackRequests.push({ method, payload });
      return {
        ok: true,
        results: {
          messages: [
            {
              channel_id: slackChannel,
              message_ts: "2.0",
              content: "Deploy succeeded",
              permalink: "https://example.slack.com/archives/C1234567890/p20",
            },
          ],
        },
      };
    },
  },
  (caller) => (caller.user === "U1" ? "test-action-token" : undefined),
  (target) => ({
    post: async (text) => {
      slackRequests.push({ method: "post", payload: { ...target, text } });
      return "3.0";
    },
  }),
);

let endpoint: McpEndpoint;
beforeAll(() => {
  endpoint = startMcpServer(admin, callerFor, [
    createMemoryTools(new MemoryStore(db)),
    createTodoTools(new TodoStore(db)),
    registerSlackTools,
  ]);
});

function callerFor(id: number): Caller | null {
  if (id === 5) return { user: "42", channel: "tg:42", conversationKey: "tg:42:8", messageTs: "5" };
  if (id === 4) return { user: "U1", channel: "C1", conversationKey: "schedule:1:42" };
  if (id === 3)
    return {
      user: "U3",
      channel: privateChannel,
      conversationKey: privateChannel,
      messageTs: "1.0",
    };
  const turn = turns.find((t) => t.message.id === id);
  return turn
    ? {
        user: turn.message.user,
        channel: turn.message.channel,
        conversationKey: turn.message.conversationKey,
      }
    : null;
}
afterAll(() => endpoint.stop());

async function connect(turnId: number, token = endpoint.token, server = endpoint) {
  const client = new Client({ name: "test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { authorization: `Bearer ${token}`, [TURN_HEADER]: String(turnId) } },
    }),
  );
  return client;
}

type Result = { content: { type: string; text: string }[]; isError?: boolean };
async function callTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as Result;
  const text = res.content[0]?.text ?? "";
  return { text, isError: res.isError ?? false, json: () => JSON.parse(text) };
}

describe("elseagent MCP server", () => {
  test("rejects requests without the token or from an unknown turn", async () => {
    expect(connect(1, "wrong")).rejects.toThrow();
    expect(connect(99)).rejects.toThrow();
  });

  test("lists the admin and schedule tools", async () => {
    const client = await connect(1);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "general_cancel_turn",
      "general_cleanup",
      "general_forget_session",
      "general_list_queue",
      "general_list_sessions",
      "general_remove_queued",
      "general_schedule_create",
      "general_schedule_delete",
      "general_schedule_list",
      "general_schedule_run_now",
      "general_status",
      "general_usage",
      "memory_delete",
      "memory_get",
      "memory_search",
      "memory_upsert",
      "slack_post",
      "slack_read_channel",
      "slack_read_thread",
      "slack_search",
      "slack_thread_follow",
      "todo_create",
      "todo_list",
      "todo_update",
    ]);
    await client.close();
  });

  test("omits Slack tools when the Slack adapter did not register them", async () => {
    const server = startMcpServer(admin, callerFor);
    try {
      const client = await connect(1, server.token, server);
      try {
        const { tools } = await client.listTools();
        expect(tools).toHaveLength(12);
        expect(tools.every((tool) => tool.name.startsWith("general_"))).toBe(true);
        expect((await callTool(client, "slack_thread_follow", { follow: false })).isError).toBe(
          true,
        );
      } finally {
        await client.close();
      }
    } finally {
      await server.stop();
    }
  });

  test("shares memories across Slack and Telegram and rejects stale updates and deletes", async () => {
    const slack = await connect(1);
    const telegram = await connect(5);
    const key = "release.report_language";
    try {
      const created = (
        await callTool(slack, "memory_upsert", {
          key,
          content: "Write release reports in Chinese.",
        })
      ).json();
      expect(created).toMatchObject({ key, updatedBy: "U1", sourceChannel: "C1" });
      expect((await callTool(telegram, "memory_search", { query: "CHINESE" })).json()).toEqual([
        created,
      ]);
      expect((await callTool(telegram, "memory_get", { key })).json()).toEqual(created);
      expect((await callTool(telegram, "memory_upsert", { key, content: "French" })).isError).toBe(
        true,
      );
      const updated = (
        await callTool(telegram, "memory_upsert", {
          key,
          content: "发布报告使用中文。",
          version: created.version,
        })
      ).json();
      expect(updated).toMatchObject({
        content: "发布报告使用中文。",
        updatedBy: "42",
        sourceChannel: "tg:42",
      });
      expect(updated.version).not.toBe(created.version);
      expect(
        (
          await callTool(slack, "memory_upsert", {
            key,
            content: "Stale change",
            version: created.version,
          })
        ).isError,
      ).toBe(true);
      expect(
        (await callTool(slack, "memory_delete", { key, version: created.version })).isError,
      ).toBe(true);
      expect(
        (await callTool(slack, "memory_delete", { key, version: updated.version })).json(),
      ).toEqual({ key, deleted: true });
      expect((await callTool(telegram, "memory_get", { key })).json()).toBeNull();
    } finally {
      await Promise.all([slack.close(), telegram.close()]);
    }
  });

  test("creates a todo in one channel and completes it in another with version checks", async () => {
    const slack = await connect(1);
    const telegram = await connect(5);
    try {
      const created = (await callTool(slack, "todo_create", { title: "Verify image tags" })).json();
      expect((await callTool(telegram, "todo_list")).json()).toEqual([created]);
      expect(created).toMatchObject({ status: "pending", sourceChannel: "C1" });
      const completed = (
        await callTool(telegram, "todo_update", {
          id: created.id,
          status: "completed",
          version: created.version,
        })
      ).json();
      expect(completed).toMatchObject({ status: "completed", sourceChannel: "tg:42" });
      expect(
        (
          await callTool(slack, "todo_update", {
            id: created.id,
            status: "cancelled",
            version: created.version,
          })
        ).isError,
      ).toBe(true);
      expect((await callTool(slack, "todo_list")).json()).toEqual([]);
      expect((await callTool(slack, "todo_list", { status: "completed" })).json()).toEqual([
        completed,
      ]);
    } finally {
      await Promise.all([slack.close(), telegram.close()]);
    }
  });

  test("posts a new top-level message to the requested public Slack channel", async () => {
    const client = await connect(1);
    try {
      const result = await callTool(client, "slack_post", {
        channel: "#ops",
        text: "Release is ready.",
      });
      expect(result.json()).toEqual({ channel: slackChannel, ts: "3.0" });
      expect(slackRequests.at(-1)).toEqual({
        method: "post",
        payload: { channel: slackChannel, ts: "", text: "Release is ready." },
      });

      const count = slackRequests.length;
      const blocked = await callTool(client, "slack_post", {
        channel: privateChannel,
        text: "Hello",
      });
      expect(blocked.isError).toBe(true);
      expect(slackRequests).toHaveLength(count);
    } finally {
      await client.close();
    }
  });

  test("scheduled Slack tools can post a separate message without an originating message", async () => {
    const client = await connect(4);
    try {
      const result = await callTool(client, "slack_post", {
        channel: slackChannel,
        text: "Scheduled alert",
      });
      expect(result.json()).toEqual({ channel: slackChannel, ts: "3.0" });
      expect(slackRequests.at(-1)?.payload).toMatchObject({
        channel: slackChannel,
        text: "Scheduled alert",
      });
    } finally {
      await client.close();
    }
  });

  test("public channel history resolves a name and supplies a cursor", async () => {
    const client = await connect(1);
    try {
      const history = (
        await callTool(client, "slack_read_channel", {
          channel: "#ops",
          cursor: "page",
          limit: 2,
          hours: 6,
        })
      ).json();
      expect(history).toMatchObject({
        channel: slackChannel,
        nextCursor: "older",
        messages: [
          { ts: "1.0", text: "old" },
          { ts: "2.0", replyCount: 2 },
        ],
      });
      expect(slackRequests.at(-1)).toMatchObject({
        method: "history",
        payload: { channel: slackChannel, cursor: "page", limit: 2, oldest: expect.any(String) },
      });
    } finally {
      await client.close();
    }
  });

  test("private history and replies are denied outside that conversation", async () => {
    const other = await connect(1);
    const local = await connect(3);
    try {
      const count = slackRequests.length;
      for (const name of ["slack_read_channel", "slack_read_thread"]) {
        const args = name === "slack_read_thread" ? { thread_ts: "1.0" } : {};
        const forbidden = await callTool(other, name, { ...args, channel: privateChannel });
        expect(forbidden.isError).toBe(true);
        expect(forbidden.text).toContain("only be read while answering");
      }
      expect(slackRequests).toHaveLength(count);

      const thread = (await callTool(local, "slack_read_thread", { thread_ts: "1.0" })).json();
      expect(thread).toMatchObject({
        channel: privateChannel,
        threadTs: "1.0",
        messages: [{ ts: "1.0" }, { ts: "2.0" }],
      });
    } finally {
      await Promise.all([other.close(), local.close()]);
    }
  });

  test("search uses the caller's action token only for public messages", async () => {
    const client = await connect(1);
    const withoutToken = await connect(2);
    try {
      const found = (
        await callTool(client, "slack_search", { query: "deploy", sort: "timestamp" })
      ).json();
      expect(found.messages[0]).toMatchObject({
        channel: slackChannel,
        ts: "2.0",
        permalink: expect.any(String),
      });
      expect(found).not.toHaveProperty("action_token");
      expect(slackRequests.at(-1)).toMatchObject({
        method: "assistant.search.context",
        payload: {
          action_token: "test-action-token",
          channel_types: "public_channel",
          content_types: "messages",
          query: "deploy",
          sort: "timestamp",
        },
      });
      const count = slackRequests.length;
      expect((await callTool(withoutToken, "slack_search", { query: "deploy" })).isError).toBe(
        true,
      );
      expect(slackRequests).toHaveLength(count);
    } finally {
      await Promise.all([client.close(), withoutToken.close()]);
    }
  });

  test("status shows running turns, queue and limits", async () => {
    queue.push({
      conversationKey: "D9",
      channel: "D9",
      ts: "5.0",
      threadTs: null,
      user: "U9",
      text: "waiting",
    });
    sessions.touch("C1:1.0", "thread-a", "1.0");
    const client = await connect(1);
    const status = (await callTool(client, "general_status")).json();
    expect(status.running.map((r: { conversation: string }) => r.conversation)).toEqual([
      "C1:1.0",
      "C1:2.0",
    ]);
    expect(status.running[0].runningForSeconds).toBeGreaterThanOrEqual(65);
    expect(status).toMatchObject({ queued: 1, sessions: 1, schedules: 0 });
    expect(status.limits.maxConcurrent).toBe(16);

    const queued = (await callTool(client, "general_list_queue")).json();
    expect(queued[0]).toMatchObject({ position: 1, conversation: "D9", text: "waiting" });
    await client.close();
  });

  test("cancel_turn stops another conversation's turn, as the caller, but not its own", async () => {
    const client = await connect(1);
    expect(
      (await callTool(client, "general_cancel_turn", { conversation: "C1:2.0" })).isError,
    ).toBe(false);
    expect(cancelled).toContainEqual(["C1:2.0", "U1"]);
    const self = await callTool(client, "general_cancel_turn", { conversation: "C1:1.0" });
    expect(self).toMatchObject({ isError: true });
    expect(self.text).toContain("can't cancel itself");
    await client.close();
  });

  test("schedule_create defaults to the caller's channel, or joins the named one", async () => {
    const client = await connect(1);
    const here = (
      await callTool(client, "general_schedule_create", {
        name: "Here",
        cron: "0 9 * * *",
        prompt: "check",
      })
    ).json();
    expect(here).toMatchObject({ channel: "C1", createdBy: "U1", timezone: "UTC" });

    const ops = (
      await callTool(client, "general_schedule_create", {
        name: "Ops",
        cron: "0 9 * * 1-5",
        prompt: "check CI",
        channel: "#ops",
        timezone: "Asia/Shanghai",
      })
    ).json();
    expect(ops).toMatchObject({ channel: "C_OPS", timezone: "Asia/Shanghai" });
    expect(ops.nextRun).toMatch(/09:00 \(Asia\/Shanghai\)$/);
    expect(ensured).toContain("#ops");

    const bad = await callTool(client, "general_schedule_create", {
      name: "x",
      cron: "* * * * *",
      prompt: "p",
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("more often");
    const privateCh = await callTool(client, "general_schedule_create", {
      name: "x",
      cron: "0 9 * * *",
      prompt: "p",
      channel: "#secret",
    });
    expect(privateCh.text).toContain("invite me");

    expect((await callTool(client, "general_schedule_list")).json()).toHaveLength(2);
    expect((await callTool(client, "general_schedule_delete", { id: here.id })).text).toContain(
      "Deleted",
    );
    expect((await callTool(client, "general_schedule_list")).json()).toHaveLength(1);
    expect((await callTool(client, "general_schedule_run_now", { id: ops.id })).text).toContain(
      "Queued",
    );
    await client.close();
  });

  test("schedule_create accepts a one-time timestamp over MCP", async () => {
    const client = await connect(1);
    const at = new Date(Date.now() + 60 * 60_000).toISOString();
    const reminder = (
      await callTool(client, "general_schedule_create", {
        name: "Reminder",
        at,
        prompt: "Send a reminder",
      })
    ).json();
    expect(reminder).toMatchObject({ name: "Reminder", cron: null, channel: "C1" });
    expect(reminder.nextRun).toMatch(/\(UTC\)$/);
    await callTool(client, "general_schedule_delete", { id: reminder.id });
    await client.close();
  });

  test("forget_session and remove_queued", async () => {
    const client = await connect(1);
    expect(
      (await callTool(client, "general_forget_session", { conversation: "C1:1.0" })).isError,
    ).toBe(false);
    expect(
      (await callTool(client, "general_forget_session", { conversation: "C1:1.0" })).isError,
    ).toBe(true);
    const [first] = (await callTool(client, "general_list_queue")).json();
    expect((await callTool(client, "general_remove_queued", { id: first.id })).isError).toBe(false);
    expect((await callTool(client, "general_list_queue")).json()).toEqual([]);
    await client.close();
  });

  test("thread_follow mutes and unmutes the caller's thread (or another one)", async () => {
    const client = await connect(1);
    const off = await callTool(client, "slack_thread_follow", { follow: false });
    expect(off.text).toContain("Stopped following C1:1.0");
    expect(sessions.followState("C1:1.0")?.muted).toBe(true);
    await callTool(client, "slack_thread_follow", { follow: true });
    expect(sessions.followState("C1:1.0")?.muted).toBe(false);
    await callTool(client, "slack_thread_follow", { follow: false, conversation: "C1:2.0" });
    expect(sessions.followState("C1:2.0")?.muted).toBe(true);
    const dm = await callTool(client, "slack_thread_follow", { follow: false, conversation: "D1" });
    expect(dm.isError).toBe(true);
    await client.close();
  });

  test("usage sums the turns of a period, by day in the agent's time zone", async () => {
    const turn = (at: string, user: string, input: number, output: number) =>
      usage.record({
        at: Date.parse(at),
        conversationKey: "C1:1.0",
        channel: "C1",
        user,
        scheduleId: null,
        threadId: "t",
        inputTokens: input,
        cachedInputTokens: 0,
        outputTokens: output,
        reasoningOutputTokens: 0,
        durationMs: 4000,
      });
    turn("2026-11-10T10:00:00Z", "U1", 100, 10);
    turn("2026-11-10T23:00:00Z", "U2", 200, 20);
    turn("2026-11-11T08:00:00Z", "U1", 300, 30);
    const client = await connect(1);
    const res = await callTool(client, "general_usage", {
      since: "2026-11-10",
      until: "2026-11-11",
      groupBy: "day",
    });
    expect(res.json()).toMatchObject({
      timezone: "UTC",
      turns: 3,
      inputTokens: 600,
      totalTokens: 660,
      averageTurnSeconds: 4,
      groups: [
        { day: "2026-11-10", turns: 2, totalTokens: 330 },
        { day: "2026-11-11", turns: 1, totalTokens: 330 },
      ],
    });
    expect((await callTool(client, "general_usage", { since: "nope" })).isError).toBe(true);
    await client.close();
  });

  test("cleanup counts on a dry run", async () => {
    const client = await connect(1);
    const res = (await callTool(client, "general_cleanup", { dryRun: true })).json();
    expect(res).toMatchObject({ dryRun: true, olderThanDays: 30, sessions: 0, codexThreads: 0 });
    expect(deletedThreads).toEqual([]);
    await client.close();
  });
});
