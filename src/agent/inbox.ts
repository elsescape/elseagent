import { conversationKey, type MessageHandler, STOP_COMMAND } from "../channels/types.ts";
import type { QueuedMessage, SessionStore } from "../state/index.ts";
import { followCommand, MUTED_REPLY, routeThreadMessage, UNMUTED_REPLY } from "./follow.ts";
import type { Scheduler } from "./scheduler.ts";

/** `!stop` (Telegram: `/stop`): stop the turn running in this conversation, right away. */
export const isStopCommand = (text: string) => text.trim().toLowerCase() === STOP_COMMAND;

export const NOTHING_TO_STOP = "Nothing is running here.";

export interface InboxDeps {
  scheduler: Pick<Scheduler, "submit" | "cancel">;
  sessions: Pick<SessionStore, "followState" | "addressed" | "noteUnanswered" | "setMuted">;
  now?: () => number;
}

/**
 * What happens to a message from any channel: `!stop`, `!mute`/`!unmute` in a thread, thread
 * messages that don't mention the agent (followed or not, see follow.ts), then the queue.
 */
export function createMessageHandler({
  scheduler,
  sessions,
  now = Date.now,
}: InboxDeps): MessageHandler {
  return async (message, reply) => {
    const key = conversationKey(message);
    const channelThread = !message.isDirect && message.threadTs !== undefined;

    // Not queued: it has to reach the running turn. Messages queued behind it still run.
    if (isStopCommand(message.text)) {
      // The stopped turn says who stopped it.
      if (!scheduler.cancel(key, message.user)) await reply.post(NOTHING_TO_STOP);
      return;
    }

    const command = channelThread ? followCommand(message.text) : null;
    if (command) {
      sessions.addressed(key); // make sure the thread has a session to hold the setting
      sessions.setMuted(key, command === "mute");
      await reply.post(command === "mute" ? MUTED_REPLY : UNMUTED_REPLY);
      return;
    }

    let mode: QueuedMessage["mode"] = "direct";
    if (message.unaddressed) {
      const route = routeThreadMessage(
        sessions.followState(key),
        { user: message.user, mentionsOthers: message.unaddressed.mentionsOthers },
        now(),
      );
      // Counted whether or not it gets a turn; the agent's next reply resets the count.
      sessions.noteUnanswered(key);
      if (route.kind === "ignore") return; // context for the next turn
      mode = route.kind;
    } else {
      if (!message.text && !message.files?.length) {
        await reply.post("Hi! Tell me what you need, and I'll get to work.");
        return;
      }
      if (channelThread) sessions.addressed(key);
    }

    const result = scheduler.submit({
      conversationKey: key,
      channel: message.channel,
      ts: message.ts,
      threadTs: message.threadTs ?? null,
      user: message.user,
      text: message.text,
      mode,
      files: message.files ?? [],
    });
    // A passive message stays quiet: nobody asked the agent anything.
    if (mode === "passive") return;
    if (result.status === "queued" && message.ts) {
      await reply.react("queued");
    } else if (result.status === "rejected") {
      await reply.post("I'm too busy right now. Please try again in a while.");
    }
  };
}
