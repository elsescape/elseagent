import { ConfigError, type TelegramConfig } from "../../config/index.ts";
import { dispatchMessage } from "../dispatch.ts";
import {
  type Channel,
  type IncomingMessage,
  type Logger,
  type MessageHandler,
  NEW_SESSION_COMMAND,
  NO_CONTEXT,
  STOP_COMMAND,
  TELEGRAM_PREFIX,
} from "../types.ts";
import { AlbumBuffer } from "./albums.ts";
import {
  TelegramApi,
  TelegramError,
  type TgCallbackQuery,
  type TgMessage,
  type TgUpdate,
  type TgUser,
} from "./api.ts";
import { TELEGRAM_INSTRUCTIONS } from "./instructions.ts";
import {
  chatChannel,
  chatIdOf,
  fromTelegramMessage,
  NOT_ALLOWED_TEXT,
  parseCommand,
  startText,
  topicOf,
} from "./message.ts";
import { CHOICE_PREFIX, createTelegramReplies, type TelegramClient } from "./reply.ts";

export interface TelegramIdentity {
  id: number;
  username: string;
  /** Threaded mode: the bot's private chats have topics, each its own conversation. */
  topicsEnabled: boolean;
}

export interface TelegramBot extends Channel {
  platform: "telegram";
  identity: TelegramIdentity;
}

export interface TelegramOptions {
  logger?: Logger;
  /** The Bot API client (tests pass a fake). */
  api?: TelegramClient;
  /** Long-polling timeout for getUpdates, in seconds. */
  pollTimeoutS?: number;
  /** Wait after a failed poll before trying again. */
  retryMs?: number;
  /** How long to wait for the rest of an album after its first message. */
  albumWaitMs?: number;
}

const PICKED = "picked";

const COMMANDS = [
  { command: "new", description: "Start this conversation over with a new session" },
  { command: "stop", description: "Stop what the agent is doing in this conversation" },
  { command: "start", description: "Show your user ID and how to use this bot" },
];

/**
 * Connect to Telegram as a bot (long polling). Verifies the token up front (getMe). Only private
 * chats are served, and only with users on `allowedUsers`; `/start` tells anyone their user ID.
 * With threaded mode on (BotFather), each topic of a chat is its own conversation.
 */
export async function createTelegramBot(
  config: TelegramConfig,
  {
    logger = console,
    api = new TelegramApi(config.botToken),
    pollTimeoutS = 50,
    retryMs = 5_000,
    albumWaitMs = 1_500,
  }: TelegramOptions = {},
): Promise<TelegramBot> {
  const me = await api.call<TgUser>("getMe").catch((err: Error) => {
    if (err instanceof TelegramError && (err.code === 401 || err.code === 404)) {
      throw new ConfigError(`Telegram rejected channels.telegram.botToken: ${err.message}`);
    }
    throw err;
  });
  const identity: TelegramIdentity = {
    id: me.id,
    username: me.username ?? String(me.id),
    topicsEnabled: me.has_topics_enabled === true,
  };
  const allowed = new Set(config.allowedUsers);
  // Display names of the users we've seen, for <@id> mentions in replies.
  const names = new Map<string, string>();
  const nameOf = (id: string) => names.get(id);
  const { sendHtml, replyTo } = createTelegramReplies({ api, logger, identity, nameOf });
  const albums = new AlbumBuffer(albumWaitMs);

  const dispatch = (onMessage: MessageHandler, message: IncomingMessage) =>
    dispatchMessage("telegram", onMessage, message, replyTo(message), logger);

  const onTelegramMessage = async (onMessage: MessageHandler, m: TgMessage) => {
    if (m.chat.type !== "private" || !m.from || m.from.is_bot) return;
    const user = String(m.from.id);
    names.set(user, m.from.first_name);
    const threadId = topicOf(m);
    const answer = (text: string) =>
      sendHtml(m.chat.id, threadId === undefined ? undefined : Number(threadId), text);
    const command = parseCommand(m.text ?? "");

    if (command?.command === "start") {
      await answer(startText(user, allowed.has(user), identity));
      return;
    }
    if (!allowed.has(user)) {
      logger.info(
        `telegram: ignored a message from ${user} (not in channels.telegram.allowedUsers)`,
      );
      await answer(NOT_ALLOWED_TEXT(user));
      return;
    }
    const message = fromTelegramMessage(m);
    if (!message) {
      await answer("I can read text, photos and files, but not this kind of message.");
      return;
    }
    // The messages of an album arrive one by one: wait for the rest, then handle them as one.
    if (m.media_group_id) {
      albums.add(`${m.chat.id}:${m.media_group_id}`, message, (album) => {
        void dispatch(onMessage, album);
      });
      return;
    }
    // `/new` goes through the queue without a message to react to, like Slack's slash command;
    // `/stop` is `!stop`.
    await dispatch(
      onMessage,
      command?.command === "new"
        ? { ...message, ts: "", text: NEW_SESSION_COMMAND }
        : command?.command === "stop"
          ? { ...message, text: STOP_COMMAND }
          : message,
    );
  };

  /** A choice button: show the pick on the message, then treat it as the user's reply. */
  const onCallback = async (onMessage: MessageHandler, q: TgCallbackQuery) => {
    const user = String(q.from.id);
    const ok = allowed.has(user);
    await api
      .call("answerCallbackQuery", {
        callback_query_id: q.id,
        text: ok ? undefined : "You're not on this agent's allow list.",
      })
      .catch(() => {});
    const posted = q.message;
    if (!ok || !posted || !q.data?.startsWith(CHOICE_PREFIX)) return;
    const label = posted.reply_markup?.inline_keyboard
      .flat()
      .find((b) => b.callback_data === q.data)?.text;
    if (!label) return;
    names.set(user, q.from.first_name);
    await api
      .call("editMessageReplyMarkup", {
        chat_id: posted.chat.id,
        message_id: posted.message_id,
        reply_markup: { inline_keyboard: [[{ text: `✓ ${label}`, callback_data: PICKED }]] },
      })
      .catch((err: Error) => logger.warn(`telegram: could not update choices: ${err.message}`));
    await dispatch(onMessage, {
      channel: chatChannel(posted.chat.id),
      ts: String(posted.message_id),
      threadTs: topicOf(posted),
      user,
      text: label,
      isDirect: true,
    });
  };

  const abort = new AbortController();
  let polling: Promise<void> | undefined;

  const poll = async (onMessage: MessageHandler) => {
    let offset = 0;
    while (!abort.signal.aborted) {
      let updates: TgUpdate[];
      try {
        updates = await api.call<TgUpdate[]>(
          "getUpdates",
          { offset, timeout: pollTimeoutS, allowed_updates: ["message", "callback_query"] },
          abort.signal,
        );
      } catch (err) {
        if (abort.signal.aborted) return;
        logger.warn(`telegram: getUpdates failed, retrying: ${(err as Error).message}`);
        await Bun.sleep(retryMs);
        continue;
      }
      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          if (update.message) await onTelegramMessage(onMessage, update.message);
          else if (update.callback_query) await onCallback(onMessage, update.callback_query);
        } catch (err) {
          logger.warn(`telegram: update ${update.update_id} failed: ${(err as Error).message}`);
        }
      }
    }
  };

  return {
    platform: "telegram",
    label: `telegram @${identity.username} (${identity.id})`,
    instructions: TELEGRAM_INSTRUCTIONS,
    identity,
    owns: (channel) => channel.startsWith(TELEGRAM_PREFIX),
    replyTo,
    // The Bot API can't read chat history; every message is addressed to the agent anyway.
    threadContext: async () => NO_CONTEXT,
    download: (file, dest, signal) => api.downloadFile(file.ref, dest, signal),
    async ensureChannel(ref) {
      const chatId = chatIdOf(ref.trim());
      if (chatId === null) throw new Error(`Telegram chats are written tg:<chat id>, not ${ref}`);
      if (!allowed.has(String(chatId))) {
        throw new Error(`${ref} is not the chat of a user in channels.telegram.allowedUsers`);
      }
      return chatChannel(chatId);
    },
    async start(onMessage) {
      if (!identity.topicsEnabled) {
        logger.warn(
          `telegram: threaded mode is off for @${identity.username}; turn it on in @BotFather ` +
            "so each topic is its own conversation (until then a chat is one conversation)",
        );
      }
      if (allowed.size === 0) {
        logger.warn(
          "telegram: channels.telegram.allowedUsers is empty; nobody can use the agent yet",
        );
      }
      // Long polling only works without a webhook.
      await api.call("deleteWebhook").catch((err: Error) => {
        logger.warn(`telegram: deleteWebhook failed: ${err.message}`);
      });
      await api.call("setMyCommands", { commands: COMMANDS }).catch((err: Error) => {
        logger.warn(`telegram: setMyCommands failed: ${err.message}`);
      });
      polling = poll(onMessage);
    },
    async stop() {
      abort.abort();
      albums.stop();
      await polling;
    },
  };
}
