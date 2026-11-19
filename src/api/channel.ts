import type { ThreadEvent } from "@openai/codex-sdk";
import { stopReason, type TurnRunner } from "../agent/scheduler.ts";
import {
  API_PREFIX,
  type Channel,
  NO_CONTEXT,
  type Reply,
  type ReplyTarget,
} from "../channels/types.ts";
import type { ApiSessionStore } from "../state/api-sessions.ts";
import type { QueuedMessage } from "../state/index.ts";
import { truncate } from "../util/text.ts";
import type { EventHub } from "./events.ts";

/**
 * The one chat of the API channel. A session is a thread of it, so its conversation key is
 * `api:chat:<session id>`, and a scheduled result opens a session like it opens a Slack thread.
 */
export const API_CHAT = `${API_PREFIX}chat`;

export const apiConversationKey = (sessionId: string) => `${API_CHAT}:${sessionId}`;

const MAX_TITLE = 80;
/** A session title from the first thing said in it. */
export const titleFrom = (text: string) =>
  truncate((text.trim().split("\n", 1)[0] ?? "").replace(/[*_`#]/g, "").trim(), MAX_TITLE);

export const API_INSTRUCTIONS = `This conversation is in elseagent's web chat, with one user. Each session of the chat is a separate conversation with you. The chat renders full Markdown, so tables are fine here.

The user sees your commands, tool calls and file changes as you work, so do not repeat them in your reply.

Scheduled results open a new session in the web chat (leave \`channel\` out to use it); the user follows up in that session.`;

/** The session a queued message belongs to; null for a scheduled run, which has none yet. */
function sessionOf(message: Pick<QueuedMessage, "channel" | "threadTs" | "scheduleId">) {
  return message.channel === API_CHAT && message.scheduleId === null ? message.threadTs : null;
}

export interface ApiChat {
  /** The API as a channel: replies become session events instead of chat messages. */
  channel: Channel;
  /** Wrap the turn runner so a session's turns are announced when they start and end. */
  observe(run: TurnRunner): TurnRunner;
  /** A Codex event of a running turn (`TurnDeps.onEvent`). */
  onCodexEvent(message: QueuedMessage, event: ThreadEvent): void;
}

export function createApiChat({
  hub,
  sessions,
  label = "api",
}: {
  hub: EventHub;
  sessions: Pick<ApiSessionStore, "create" | "touch">;
  label?: string;
}): ApiChat {
  /** Messages whose turn is running, and whether it reported a failure (the "failed" reaction). */
  const failed = new Map<string, boolean>();

  const replyTo = (target: ReplyTarget): Reply => {
    let sessionId = target.threadTs ?? null;
    return {
      async post(markdown, choices = [], files = []) {
        // Only a scheduled result has no session: it opens one, where the user can follow up.
        sessionId ??= sessions.create(titleFrom(markdown)).id;
        hub.publish(sessionId, target.ts, {
          type: "reply",
          // Elsewhere `<@id>` is a mention; here it would be read as an HTML tag and dropped.
          text: markdown.replace(/<@([^>\s]+)>/g, "@$1"),
          choices,
          files: files.map(({ name, path }) => ({ name, path })),
        });
        sessions.touch(sessionId);
        return sessionId;
      },
      async react(reaction) {
        if (reaction === "failed" && failed.has(target.ts)) failed.set(target.ts, true);
      },
      async unreact() {},
      async setStatus(text) {
        if (sessionId) hub.publish(sessionId, target.ts, { type: "status", text });
      },
    };
  };

  return {
    channel: {
      platform: "api",
      label,
      stateKey: "api",
      instructions: API_INSTRUCTIONS,
      // Messages arrive over HTTP (see server.ts), not through a connection of the channel's own.
      async start() {},
      async stop() {},
      owns: (channel) => channel.startsWith(API_PREFIX),
      replyTo,
      threadContext: async () => NO_CONTEXT,
      async download() {
        throw new Error("the API channel has no attachments");
      },
      async ensureChannel() {
        return API_CHAT;
      },
    },
    observe: (run) => async (message, signal) => {
      const sessionId = sessionOf(message);
      if (!sessionId) return run(message, signal);
      // After a restart the message comes from the queue, and nothing has announced it here.
      if (!hub.has(sessionId, message.ts)) {
        const { text, user } = message;
        hub.publish(sessionId, message.ts, { type: "user_message", text, user });
      }
      hub.publish(sessionId, message.ts, { type: "turn_started" });
      failed.set(message.ts, false);
      try {
        await run(message, signal);
      } finally {
        const reportedFailure = failed.get(message.ts) === true;
        failed.delete(message.ts);
        hub.publish(sessionId, message.ts, {
          type: "turn_ended",
          status: stopReason(signal) ? "interrupted" : reportedFailure ? "failed" : "completed",
        });
      }
    },
    onCodexEvent(message, event) {
      const sessionId = sessionOf(message);
      if (sessionId) hub.publish(sessionId, message.ts, { type: "codex", event });
    },
  };
}
