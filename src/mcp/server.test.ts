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
import { registerSlackTools } from "../channels/slack/tools.ts";
import {
  MessageQueue,
  openStateDb,
  ScheduleStore,
  SessionStore,
  UsageStore,
} from "../state/index.ts";
import { type McpEndpoint, startMcpServer, TURN_HEADER } from "./server.ts";

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

let endpoint: McpEndpoint;
beforeAll(() => {
  endpoint = startMcpServer(admin, callerFor, [registerSlackTools]);
});

function callerFor(id: number): Caller | null {
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
      "slack_thread_follow",
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
