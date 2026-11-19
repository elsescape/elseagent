import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type Admin, AdminError, type Caller } from "../agent/admin.ts";
import { USAGE_GROUPS } from "../agent/usage.ts";

/** Header carrying the queue message id of the turn that makes the call. */
export const TURN_HEADER = "x-elseagent-turn";
/** Environment variable through which Codex receives the bearer token. */
export const TOKEN_ENV = "ELSEAGENT_MCP_TOKEN";

export interface McpEndpoint {
  url: string;
  token: string;
  stop(): Promise<void>;
}

const text = (value: unknown): CallToolResult => ({
  content: [
    { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
  ],
});

/** Run a tool, turning AdminError into a tool error Codex can read and react to. */
async function call(fn: () => unknown): Promise<CallToolResult> {
  try {
    return text(await fn());
  } catch (err) {
    if (err instanceof AdminError) return { ...text(err.message), isError: true };
    throw err;
  }
}

/** The elseagent tools, bound to the caller of one request. */
export function buildMcpServer(admin: Admin, caller: Caller): McpServer {
  const server = new McpServer({ name: "elseagent", version: "1.0.0" });
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool(
    "status",
    {
      description:
        "This agent's state: limits, turns running now (conversation, user, how long), " +
        "queued message count, session count, schedule count.",
      annotations: readOnly,
    },
    () => call(() => admin.status()),
  );
  server.registerTool(
    "list_queue",
    {
      description: "Messages waiting for a free slot, oldest first (id, conversation, user, text).",
      inputSchema: { limit: z.number().int().positive().max(200).optional() },
      annotations: readOnly,
    },
    ({ limit }) => call(() => admin.listQueue(limit)),
  );
  server.registerTool(
    "list_sessions",
    {
      description:
        "Conversations with a Codex session, most recently active first. A conversation is " +
        "`channel:threadTs`, or `channel` for a DM's top level (Telegram: `tg:<chat>:<topic>`).",
      inputSchema: { limit: z.number().int().positive().max(200).optional() },
      annotations: readOnly,
    },
    ({ limit }) => call(() => admin.listSessions(limit)),
  );
  server.registerTool(
    "cancel_turn",
    {
      description:
        "Force-stop the turn running in a conversation (see `status`). Its thread is told who " +
        "stopped it; the session is kept. Cannot stop the turn you are running in.",
      inputSchema: { conversation: z.string() },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    ({ conversation }) => call(() => admin.cancelTurn(conversation, caller)),
  );
  server.registerTool(
    "remove_queued",
    {
      description: "Drop a queued message that has not started (id from `list_queue`).",
      inputSchema: { id: z.number().int() },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    ({ id }) => call(() => admin.removeQueued(id)),
  );
  server.registerTool(
    "thread_follow",
    {
      description:
        "Stop following a Slack thread (follow=false: only answer when mentioned there) or follow " +
        "it again (follow=true: read every reply and decide whether to answer). Use it when someone " +
        "asks you to stay out of a thread or to come back. Defaults to the current thread.",
      inputSchema: {
        follow: z.boolean(),
        conversation: z
          .string()
          .optional()
          .describe("A conversation from list_sessions; defaults to the current one"),
      },
      annotations: { openWorldHint: false },
    },
    ({ follow, conversation }) => call(() => admin.threadFollow(follow, caller, conversation)),
  );
  server.registerTool(
    "forget_session",
    {
      description: "Drop a conversation's Codex session; its next message starts a new session.",
      inputSchema: { conversation: z.string() },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    ({ conversation }) => call(() => admin.forgetSession(conversation)),
  );
  server.registerTool(
    "usage",
    {
      description:
        "Codex token usage of this agent over a period: turns, input tokens (cached ones " +
        "included), output tokens (reasoning included), optionally broken down by day, user, " +
        "channel, conversation or schedule. Defaults to the last 7 days. Dates are in the " +
        "agent's time zone (returned with the result).",
      inputSchema: {
        since: z
          .string()
          .optional()
          .describe("Start: YYYY-MM-DD (start of that day) or an ISO 8601 date-time"),
        until: z
          .string()
          .optional()
          .describe("End: YYYY-MM-DD (that day included) or an ISO 8601 date-time; default now"),
        days: z
          .number()
          .int()
          .positive()
          .max(3660)
          .optional()
          .describe("Without since: this many days before until (default 7)"),
        groupBy: z.enum(USAGE_GROUPS).optional(),
      },
      annotations: readOnly,
    },
    (input) => call(() => admin.usage(input)),
  );
  server.registerTool(
    "cleanup",
    {
      description:
        "Free space taken by old conversations: for conversations idle more than " +
        "`olderThanDays` (default 30), delete their sessions, their Codex sessions (history " +
        "saved by Codex) and the files people attached. If such a conversation becomes active " +
        "again, it starts a new Codex session that reads the thread again. Usage records are " +
        "kept. Run with dryRun first to see what would be deleted, and confirm with the user.",
      inputSchema: {
        olderThanDays: z.number().int().min(1).max(3650).optional(),
        dryRun: z.boolean().optional().describe("Only count what would be deleted"),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    (input) => call(() => admin.cleanup(input)),
  );
  server.registerTool(
    "schedule_create",
    {
      description:
        "Create a recurring or one-time task. Provide exactly one of cron or at. Each run uses a new Codex session to do `prompt` and posts " +
        "its result or a brief error as a new message in `channel` (in Telegram, a new topic). " +
        "Runs may stay silent with reply: false. People can follow up to recover the session. Runs at most " +
        "every 5 minutes. Confirm the schedule (next run time) to the user afterwards.",
      inputSchema: {
        name: z.string().min(1).max(80).describe("Short name, e.g. 'Daily CI check'"),
        cron: z.string().optional().describe("Cron expression, 5 fields, e.g. '0 9 * * 1-5'"),
        at: z
          .string()
          .optional()
          .describe("One-time ISO 8601 date-time with offset or Z, e.g. 2026-11-20T15:00:00+08:00"),
        prompt: z.string().min(1).describe("What to do on each run, written as an instruction"),
        channel: z
          .string()
          .optional()
          .describe(
            "Slack channel name or ID, or a Telegram chat as tg:<chat id>; defaults to the " +
              "current conversation's channel",
          ),
        timezone: z
          .string()
          .optional()
          .describe("IANA time zone, e.g. Asia/Shanghai; defaults to the agent's time zone"),
      },
      annotations: { openWorldHint: false },
    },
    (input) => call(() => admin.scheduleCreate(input, caller)),
  );
  server.registerTool(
    "schedule_list",
    {
      description: "All scheduled tasks with their next run and most recent skipped occurrence.",
      annotations: readOnly,
    },
    () => call(() => admin.scheduleList()),
  );
  server.registerTool(
    "schedule_delete",
    {
      description: "Delete a scheduled task by id.",
      inputSchema: { id: z.number().int() },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    ({ id }) => call(() => admin.scheduleDelete(id)),
  );
  server.registerTool(
    "schedule_run_now",
    {
      description: "Queue a manual run now without changing the next automatic run.",
      inputSchema: { id: z.number().int() },
      annotations: { openWorldHint: false },
    },
    ({ id }) => call(() => admin.scheduleRunNow(id)),
  );
  return server;
}

/**
 * Serve the elseagent tools over MCP (streamable HTTP) on 127.0.0.1, for this process's Codex
 * turns only: requests need the bearer token and the id of a turn that is running.
 */
export function startMcpServer(
  admin: Admin,
  callerFor: (turnId: number) => Caller | null,
): McpEndpoint {
  const token = crypto.randomUUID();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (req.headers.get("authorization") !== `Bearer ${token}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const caller = callerFor(Number(req.headers.get(TURN_HEADER)));
      if (!caller) return new Response("unknown or finished turn", { status: 403 });
      // Stateless: a fresh server and transport per request.
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await buildMcpServer(admin, caller).connect(transport);
      return transport.handleRequest(req);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    token,
    stop: () => server.stop(true),
  };
}
