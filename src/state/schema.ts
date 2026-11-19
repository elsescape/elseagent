import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Attachment } from "../channels/types.ts";

// Conversation history is kept by Codex itself.

/** Maps a conversation (thread, or top-level DM) to the Codex thread holding its context. */
export const sessions = sqliteTable(
  "sessions",
  {
    conversationKey: text("conversation_key").primaryKey(),
    threadId: text("thread_id").notNull(),
    /** Unix epoch milliseconds. */
    lastActiveAt: integer("last_active_at").notNull(),
    /** ID (ts) of the last message Codex has seen; thread context starts after it. */
    lastSeenTs: text("last_seen_ts"),
    /**
     * Thread following (Slack channel threads): the agent reads messages that don't mention it
     * and decides whether to reply. Muted threads only get replies when it is mentioned.
     */
    muted: integer("muted", { mode: "boolean" }).notNull().default(false),
    /** Unix epoch ms the agent was last mentioned or last replied here. */
    lastAddressedAt: integer("last_addressed_at"),
    /** Messages in the thread since the agent's last reply. */
    unanswered: integer("unanswered").notNull().default(0),
    /** Who the agent's last reply answered: their next message is likely a reply to it. */
    repliedTo: text("replied_to"),
  },
  (t) => [index("sessions_last_active").on(t.lastActiveAt)],
);

/**
 * Buffer of messages not yet answered: waiting for a slot, or being handled right now.
 * A row is deleted as soon as its turn ends, so this never grows into a message history.
 */
export const queue = sqliteTable(
  "queue",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    conversationKey: text("conversation_key").notNull(),
    channel: text("channel").notNull(),
    ts: text("ts").notNull(),
    threadTs: text("thread_ts"),
    user: text("user").notNull(),
    text: text("text").notNull(),
    status: text("status", { enum: ["pending", "running"] })
      .notNull()
      .default("pending"),
    /** Set for a scheduled run: there is no user message; a posted result opens the conversation. */
    scheduleId: integer("schedule_id"),
    /**
     * direct: addressed to the agent, which answers. followup: a thread reply to the agent's last
     * answer, without a mention; it answers unless it's a mere acknowledgement. passive: a thread
     * message not addressed to the agent, which decides whether to reply. Passive runs last.
     */
    mode: text("mode", { enum: ["direct", "followup", "passive"] })
      .notNull()
      .default("direct"),
    /** Files attached to the message, downloaded when its turn starts. */
    files: text("files", { mode: "json" }).$type<Attachment[]>().notNull().default(sql`'[]'`),
  },
  (t) => [
    index("queue_status").on(t.status, t.id),
    index("queue_conversation").on(t.conversationKey, t.status),
  ],
);

/** Scheduled tasks created by users through the agent ("check X every morning, post in #ops"). */
export const schedules = sqliteTable(
  "schedules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    /** Cron expression (5 or 6 fields), evaluated in `timezone`. */
    cron: text("cron"),
    /** IANA time zone, e.g. Asia/Shanghai. */
    timezone: text("timezone").notNull(),
    /** Chat the results are posted to: a Slack channel ID, or `tg:<chat id>`. */
    channel: text("channel").notNull(),
    /** What Codex is asked to do on each run. */
    prompt: text("prompt").notNull(),
    createdBy: text("created_by").notNull(),
    /** Unix epoch milliseconds. */
    createdAt: integer("created_at").notNull(),
    nextRunAt: integer("next_run_at"),
    lastRunAt: integer("last_run_at"),
    lastSkippedAt: integer("last_skipped_at"),
  },
  (t) => [index("schedules_next_run").on(t.nextRunAt)],
);

/** Token usage of each completed Codex turn, for usage reports. Kept when sessions are deleted. */
export const usage = sqliteTable(
  "usage",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Unix epoch ms the turn ended. */
    at: integer("at").notNull(),
    conversationKey: text("conversation_key").notNull(),
    channel: text("channel").notNull(),
    /** Who asked; empty for a scheduled run. */
    user: text("user").notNull(),
    scheduleId: integer("schedule_id"),
    threadId: text("thread_id"),
    inputTokens: integer("input_tokens").notNull(),
    cachedInputTokens: integer("cached_input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    reasoningOutputTokens: integer("reasoning_output_tokens").notNull(),
    durationMs: integer("duration_ms").notNull(),
  },
  (t) => [index("usage_at").on(t.at)],
);

/**
 * Codex threads the agent created and when each was last used, including ones no conversation
 * maps to any more (after `/new`), so cleanup can delete them from Codex's own storage.
 */
export const codexThreads = sqliteTable(
  "codex_threads",
  {
    threadId: text("thread_id").primaryKey(),
    conversationKey: text("conversation_key").notNull(),
    /** Unix epoch ms. */
    lastUsedAt: integer("last_used_at").notNull(),
  },
  (t) => [index("codex_threads_last_used").on(t.lastUsedAt)],
);

/** Long-lived facts and preferences shared by this agent's conversations. */
export const memories = sqliteTable("memories", {
  key: text("key").primaryKey(),
  content: text("content").notNull(),
  version: text("version").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  updatedBy: text("updated_by").notNull(),
  sourceChannel: text("source_channel").notNull(),
  sourceConversation: text("source_conversation").notNull(),
});

export const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;

/** Tasks this agent can pick up in a later conversation. */
export const todos = sqliteTable(
  "todos",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    title: text("title").notNull(),
    details: text("details").notNull().default(""),
    status: text("status", { enum: TODO_STATUSES }).notNull().default("pending"),
    version: text("version").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    updatedBy: text("updated_by").notNull(),
    sourceChannel: text("source_channel").notNull(),
    sourceConversation: text("source_conversation").notNull(),
  },
  (t) => [index("todos_status_updated").on(t.status, t.updatedAt)],
);
