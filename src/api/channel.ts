import { basename, isAbsolute, relative, sep } from "node:path";
import type { ThreadEvent } from "@openai/codex-sdk";
import type { TurnOutcome, TurnRunner } from "../agent/scheduler.ts";
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
import type { EventFile, EventHub, TurnStatus } from "./events.ts";

/**
 * The one chat of the API channel. A session is a thread of it, so its conversation key is
 * `api:chat:<session id>`, and a scheduled result opens a session like it opens a Slack thread.
 */
export const API_CHAT = `${API_PREFIX}chat`;

/** Names the database of an agent with no chat service connected (see `ConnectedChannel`). */
export const API_STATE_KEY = "api";

export const apiConversationKey = (sessionId: string) => `${API_CHAT}:${sessionId}`;

const MAX_TITLE = 80;
/** A session title from the first thing said in it. */
export const titleFrom = (text: string) =>
  truncate((text.trim().split("\n", 1)[0] ?? "").replace(/[*_`#]/g, "").trim(), MAX_TITLE);

const API_INSTRUCTIONS = `This conversation comes through elseagent's HTTP API, from a chat client with one user. Each session is a separate conversation with you.

The user can attach files and images to a message. They can download the files you send back only from inside your working directory, so write anything you put in "files" there.

Scheduled results open a new session (leave \`channel\` out to use it); the user follows up in that session.`;

/** The session a queued message belongs to; null for a scheduled run, which has none yet. */
function sessionOf(message: Pick<QueuedMessage, "channel" | "threadTs" | "scheduleId">) {
  return message.channel === API_CHAT && message.scheduleId === null ? message.threadTs : null;
}

/** How a turn's outcome is told to API clients. */
const TURN_STATUS: Record<TurnOutcome, TurnStatus> = {
  completed: "completed",
  failed: "failed",
  timed_out: "failed",
  stopped: "interrupted",
};

export interface ApiChat {
  /** The API as a channel: replies become session events instead of chat messages. */
  channel: Channel;
  /** Wrap the turn runner so a session's turns are announced when they start and end. */
  observe(run: TurnRunner): TurnRunner;
  /** A Codex event of a running turn (`TurnDeps.onEvent`). */
  onCodexEvent(message: QueuedMessage, event: ThreadEvent): void;
}

/** A file as events name it: by its path in the workspace when it is inside. */
export function eventFile(path: string, workspace: string): EventFile {
  const inside = relative(workspace, path);
  const outside = inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside);
  return { name: basename(path), path: outside ? path : inside };
}

/**
 * Tell the session's listeners about a user message, once: when it is submitted, or, for one
 * that was still queued when the agent restarted, when its turn starts.
 */
export function announce(
  hub: EventHub,
  workspace: string,
  sessionId: string,
  message: Pick<QueuedMessage, "ts" | "text" | "user" | "files">,
): void {
  if (hub.has(sessionId, message.ts)) return;
  const { text, user } = message;
  const files = message.files.flatMap((f) => (f.path ? [eventFile(f.path, workspace)] : []));
  hub.publish(sessionId, message.ts, { type: "user_message", text, user, files });
}

export function createApiChat({
  hub,
  sessions,
  workspace,
}: {
  hub: EventHub;
  sessions: Pick<ApiSessionStore, "create" | "touch">;
  /** Codex's working directory; files in events are named relative to it. */
  workspace: string;
}): ApiChat {
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
          files: files.map((file) => eventFile(file.path, workspace)),
        });
        sessions.touch(sessionId);
        return sessionId;
      },
      // Clients follow a turn through its events; there is no message to put a mark on.
      async react() {},
      async unreact() {},
      async setStatus(text) {
        if (sessionId) hub.publish(sessionId, target.ts, { type: "status", text });
      },
    };
  };

  return {
    channel: {
      platform: "api",
      label: "api",
      instructions: API_INSTRUCTIONS,
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
      announce(hub, workspace, sessionId, message);
      hub.publish(sessionId, message.ts, { type: "turn_started" });
      // Until the runner says otherwise: if it throws, the turn failed.
      let status: TurnStatus = "failed";
      try {
        const outcome = await run(message, signal);
        status = TURN_STATUS[outcome ?? "completed"];
        return outcome;
      } finally {
        hub.publish(sessionId, message.ts, { type: "turn_ended", status });
      }
    },
    onCodexEvent(message, event) {
      const sessionId = sessionOf(message);
      if (sessionId) hub.publish(sessionId, message.ts, { type: "codex", event });
    },
  };
}
