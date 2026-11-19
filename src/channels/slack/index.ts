import { App, type BlockButtonAction, LogLevel, SocketModeReceiver, webApi } from "@slack/bolt";
import { ConfigError, type SlackConfig } from "../../config/index.ts";
import { dispatchMessage } from "../dispatch.ts";
import { replyParts } from "../markdown.ts";
import {
  type Channel,
  type IncomingMessage,
  type Logger,
  NEW_SESSION_COMMAND,
  NO_CONTEXT,
  type Reply,
  type ReplyTarget,
  TELEGRAM_PREFIX,
} from "../types.ts";
import { ensureChannel, joinChannels } from "./channels.ts";
import { CHOICE_ACTION, choiceBlocks, resolvedBlocks } from "./choices.ts";
import { fetchThreadContext } from "./context.ts";
import { downloadSlackFile } from "./files.ts";
import { SLACK_INSTRUCTIONS } from "./instructions.ts";
import {
  deduplicateMessages,
  fromDirectMessage,
  fromMention,
  fromThreadMessage,
  isDm,
  REACTION_NAMES,
  slashCommandMessage,
  stopButtonMessage,
} from "./message.ts";

/** Slack's limit for `markdown_text` is 12,000 characters; stay under it. */
export const SLACK_MARKDOWN_LIMIT = 11_000;

/** How long Socket Mode waits for a pong (and for Slack's pings) before reconnecting. */
export const SOCKET_PING_TIMEOUT_MS = 30_000;

export interface SlackIdentity {
  /** The bot's user ID, e.g. U0123 (what <@U0123> mentions refer to). */
  userId: string;
  /** The bot's name as configured in the Slack app. */
  name: string;
  teamId: string;
}

export interface SlackBot extends Channel {
  platform: "slack";
  identity: SlackIdentity;
}

/** Telegram's channel IDs; everything else is Slack's. */
const isOtherPlatform = (channel: string) => channel.startsWith(TELEGRAM_PREFIX);

/**
 * Prepare a Socket Mode connection. Verifies the bot token up front (auth.test) so bad
 * credentials fail at startup, and learns the bot's own identity for mention handling.
 */
export async function createSlackBot(
  config: SlackConfig,
  logger: Logger = console,
): Promise<SlackBot> {
  // Verify the token ourselves before creating the App: Bolt's own verification runs inside
  // the constructor and its failure would surface as an unhandled rejection.
  const auth = await new webApi.WebClient(config.botToken).auth.test().catch((err: Error) => {
    throw new ConfigError(`Slack rejected slack.botToken: ${err.message}`);
  });
  if (!auth.user_id || !auth.team_id) throw new Error("slack: auth.test returned no user/team id");
  const identity: SlackIdentity = {
    userId: auth.user_id,
    name: auth.user ?? auth.user_id,
    teamId: auth.team_id,
  };

  // Socket Mode drops and reconnects when a pong to its ping is late. Its 5 s default trips on
  // ordinary network hiccups; 30 s still notices a dead connection quickly (Slack's own pings
  // to us are checked separately, with the same 30 s).
  const receiver = new SocketModeReceiver({
    appToken: config.appToken,
    logLevel: LogLevel.WARN,
    clientPingTimeout: SOCKET_PING_TIMEOUT_MS,
    serverPingTimeout: SOCKET_PING_TIMEOUT_MS,
  });
  const app = new App({
    token: config.botToken,
    receiver,
    logLevel: LogLevel.WARN,
    tokenVerificationEnabled: false,
    botUserId: auth.user_id,
    botId: auth.bot_id,
  });
  const { client } = app;
  // Slack sends Stop for the root message even when the turn belongs to the top-level DM.
  const topLevelDmSessions = new Map<string, string>();

  const replyTo = (target: ReplyTarget): Reply => ({
    async post(markdown, choices = [], files = []) {
      const parts = replyParts(markdown, files.length > 0, SLACK_MARKDOWN_LIMIT);
      let first: string | undefined;
      for (const [i, part] of parts.entries()) {
        // Continuation parts of a new top-level message go into its thread.
        const thread_ts = target.threadTs ?? first;
        const res =
          i === parts.length - 1 && choices.length > 0
            ? await client.chat.postMessage({
                channel: target.channel,
                thread_ts,
                blocks: choiceBlocks(part, choices),
                text: part,
              })
            : await client.chat.postMessage({
                channel: target.channel,
                thread_ts,
                markdown_text: part,
              });
        first ??= res.ts;
      }
      if (files.length > 0) {
        const thread_ts = target.threadTs ?? first;
        try {
          const file_uploads = await Promise.all(
            files.map(async (f) => ({
              file: Buffer.from(await Bun.file(f.path).arrayBuffer()),
              filename: f.name,
            })),
          );
          await client.files.uploadV2({
            channel_id: target.channel,
            ...(thread_ts ? { thread_ts } : {}),
            file_uploads,
          });
        } catch (err) {
          const names = files.map((f) => `\`${f.name}\``).join(", ");
          logger.warn(`slack: could not upload ${names}: ${(err as Error).message}`);
          const res = await client.chat.postMessage({
            channel: target.channel,
            thread_ts,
            markdown_text: `_Could not send ${names}: ${(err as Error).message}_`,
          });
          first ??= res.ts;
        }
      }
      return first;
    },
    async react(reaction) {
      await client.reactions
        .add({ channel: target.channel, timestamp: target.ts, name: REACTION_NAMES[reaction] })
        .catch(() => {});
    },
    async unreact(reaction) {
      await client.reactions
        .remove({ channel: target.channel, timestamp: target.ts, name: REACTION_NAMES[reaction] })
        .catch(() => {});
    },
    async setStatus(status) {
      const topLevelDm = !target.threadTs && isDm(target.channel);
      const threadTs = target.threadTs ?? (topLevelDm ? target.ts : undefined);
      if (!threadTs) return;
      if (topLevelDm && status) topLevelDmSessions.set(target.channel, threadTs);
      try {
        await client.apiCall("agents.sessions.setStatus", {
          channel_id: target.channel,
          thread_ts: threadTs,
          status: status ? "processing" : "active",
        });
      } catch (err) {
        logger.warn(`slack: could not set agent session status: ${(err as Error).message}`);
      } finally {
        if (topLevelDm && !status && topLevelDmSessions.get(target.channel) === threadTs) {
          topLevelDmSessions.delete(target.channel);
        }
      }
    },
  });

  app.error(async (err) => {
    logger.warn(`slack: ${err.message}`);
  });

  return {
    platform: "slack",
    label: `slack @${identity.name} (${identity.userId})`,
    instructions: SLACK_INSTRUCTIONS,
    identity,
    owns: (channel) => !isOtherPlatform(channel),
    replyTo,
    threadContext: (message, afterTs) =>
      message.threadTs
        ? fetchThreadContext(
            client,
            { channel: message.channel, threadTs: message.threadTs, afterTs, beforeTs: message.ts },
            identity.userId,
          )
        : Promise.resolve(NO_CONTEXT), // top-level DM: nothing to add
    download: (file, dest, signal) => downloadSlackFile(config.botToken, file, dest, signal),
    ensureChannel: (ref) => ensureChannel(client, ref),
    async start(onMessage) {
      const dispatch = (message: IncomingMessage) =>
        dispatchMessage("slack", onMessage, message, replyTo(message), logger);
      const dispatchOnce = deduplicateMessages(dispatch);
      app.event("app_mention", async ({ event }) => {
        const message = fromMention(event, identity.userId);
        if (message) await dispatchOnce(message);
      });
      app.message(async ({ message: event }) => {
        const message =
          fromDirectMessage(event, identity.userId) ??
          (config.threadReplies === "auto" ? fromThreadMessage(event, identity.userId) : null);
        if (message) await dispatchOnce(message);
      });
      // The stopped turn returns its Slack session to active during cleanup.
      app.event("agent_session_stopped", async ({ event }) => {
        if (!event.thread_ts) return;
        const message = stopButtonMessage(event);
        if (topLevelDmSessions.get(event.channel) === event.thread_ts) message.threadTs = undefined;
        await dispatch(message);
      });
      // `/new` in a DM starts it over; it goes through the queue like a message (no ts: there
      // is no Slack message behind a slash command). Elsewhere, explain where it works.
      app.command("/new", async ({ ack, command }) => {
        if (!isDm(command.channel_id)) {
          await ack({
            response_type: "ephemeral",
            text: "`/new` works in a direct message with me: it starts our DM over.",
          });
          return;
        }
        await ack();
        await dispatch(
          slashCommandMessage(command.channel_id, command.user_id, NEW_SESSION_COMMAND),
        );
      });
      // A choice button: record the pick on the message, then treat it as the user's reply.
      app.action<BlockButtonAction>({ action_id: CHOICE_ACTION }, async ({ ack, body, action }) => {
        await ack();
        const channel = body.channel?.id;
        const posted = body.message;
        if (!channel || !posted) return;
        await client.chat
          .update({
            channel,
            ts: posted.ts,
            text: posted.text ?? action.value ?? "",
            blocks: resolvedBlocks(posted.blocks ?? [], body.user.id, action.value ?? ""),
          })
          .catch((err: Error) => logger.warn(`slack: could not update choices: ${err.message}`));
        await dispatch({
          channel,
          ts: posted.ts,
          threadTs: posted.thread_ts,
          user: body.user.id,
          text: action.value ?? "",
          isDirect: isDm(channel),
        });
      });
      await app.start();
      await joinChannels(app.client, config.join, logger);
    },
    async stop() {
      await app.stop();
    },
  };
}
