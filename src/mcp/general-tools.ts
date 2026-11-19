import { z } from "zod";
import { USAGE_GROUPS } from "../agent/usage.ts";
import { callTool, type ToolGroup } from "./tools.ts";

export const registerGeneralTools: ToolGroup = (server, admin, caller) => {
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool(
    "general_status",
    {
      description:
        "This agent's state: limits, turns running now (conversation, user, how long), " +
        "queued message count, session count, schedule count.",
      annotations: readOnly,
    },
    () => callTool(() => admin.status()),
  );
  server.registerTool(
    "general_list_queue",
    {
      description: "Messages waiting for a free slot, oldest first (id, conversation, user, text).",
      inputSchema: { limit: z.number().int().positive().max(200).optional() },
      annotations: readOnly,
    },
    ({ limit }) => callTool(() => admin.listQueue(limit)),
  );
  server.registerTool(
    "general_list_sessions",
    {
      description:
        "Conversations with a Codex session, most recently active first. A conversation is " +
        "`channel:threadTs` for a thread, or `channel` for a top-level conversation.",
      inputSchema: { limit: z.number().int().positive().max(200).optional() },
      annotations: readOnly,
    },
    ({ limit }) => callTool(() => admin.listSessions(limit)),
  );
  server.registerTool(
    "general_cancel_turn",
    {
      description:
        "Force-stop the turn running in a conversation (see `general_status`). Its thread is told who " +
        "stopped it; the session is kept. Cannot stop the turn you are running in.",
      inputSchema: { conversation: z.string() },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    ({ conversation }) => callTool(() => admin.cancelTurn(conversation, caller)),
  );
  server.registerTool(
    "general_remove_queued",
    {
      description: "Drop a queued message that has not started (id from `general_list_queue`).",
      inputSchema: { id: z.number().int() },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    ({ id }) => callTool(() => admin.removeQueued(id)),
  );
  server.registerTool(
    "general_forget_session",
    {
      description: "Drop a conversation's Codex session; its next message starts a new session.",
      inputSchema: { conversation: z.string() },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    ({ conversation }) => callTool(() => admin.forgetSession(conversation)),
  );
  server.registerTool(
    "general_usage",
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
    (input) => callTool(() => admin.usage(input)),
  );
  server.registerTool(
    "general_cleanup",
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
    (input) => callTool(() => admin.cleanup(input)),
  );
  server.registerTool(
    "general_schedule_create",
    {
      description:
        "Create a recurring or one-time task. Provide exactly one of cron or at. Each run uses a new Codex session to do `prompt` and posts " +
        "its result or a brief error in a new conversation at the chosen destination. " +
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
          .describe("A channel reference or ID; defaults to the current conversation's channel"),
        timezone: z
          .string()
          .optional()
          .describe("IANA time zone, e.g. Asia/Shanghai; defaults to the agent's time zone"),
      },
      annotations: { openWorldHint: false },
    },
    (input) => callTool(() => admin.scheduleCreate(input, caller)),
  );
  server.registerTool(
    "general_schedule_list",
    {
      description: "All scheduled tasks with their next run and most recent skipped occurrence.",
      annotations: readOnly,
    },
    () => callTool(() => admin.scheduleList()),
  );
  server.registerTool(
    "general_schedule_delete",
    {
      description: "Delete a scheduled task by id.",
      inputSchema: { id: z.number().int() },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    ({ id }) => callTool(() => admin.scheduleDelete(id)),
  );
  server.registerTool(
    "general_schedule_run_now",
    {
      description: "Queue a manual run now without changing the next automatic run.",
      inputSchema: { id: z.number().int() },
      annotations: { openWorldHint: false },
    },
    ({ id }) => callTool(() => admin.scheduleRunNow(id)),
  );
};
