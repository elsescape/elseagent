import { ConfigError, type TelegramConfig } from "../../config/index.ts";
import { formatSize } from "../../util/text.ts";
import { dispatchMessage } from "../dispatch.ts";
import { replyParts } from "../markdown.ts";
import {
  type Channel,
  type IncomingMessage,
  type Logger,
  type MessageHandler,
  NEW_SESSION_COMMAND,
  NO_CONTEXT,
  type OutgoingFile,
  type Reply,
  type ReplyTarget,
  STOP_COMMAND,
  TELEGRAM_PREFIX,
} from "../types.ts";
import {
  TelegramApi,
  TelegramError,
  type TgCallbackQuery,
  type TgForumTopic,
  type TgInlineKeyboard,
  type TgMessage,
  type TgUpdate,
  type TgUser,
} from "./api.ts";
import { plainLine, TELEGRAM_MARKDOWN_LIMIT, toTelegramHtml } from "./format.ts";
import { TELEGRAM_INSTRUCTIONS } from "./instructions.ts";
import {
  chatChannel,
  chatIdOf,
  fromTelegramMessage,
  isPhotoFile,
  MAX_UPLOAD_BYTES,
  mergeAlbum,
  NOT_ALLOWED_TEXT,
  parseCommand,
  REACTION_EMOJI,
  startText,
  statusText,
  topicOf,
} from "./message.ts";

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
  api?: Pick<TelegramApi, "call" | "upload" | "downloadFile">;
  /** Long-polling timeout for getUpdates, in seconds. */
  pollTimeoutS?: number;
  /** Wait after a failed poll before trying again. */
  retryMs?: number;
  /** How long to wait for the rest of an album after its first message. */
  albumWaitMs?: number;
}

const CHOICE_PREFIX = "choice:";
const PICKED = "picked";
/** Drafts disappear after 30 s, so a status shown as a draft is re-sent before then. */
const DRAFT_REFRESH_MS = 20_000;
/** "typing…" lasts 5 s. */
const TYPING_REFRESH_MS = 4_000;

const COMMANDS = [
  { command: "new", description: "Start this conversation over with a new session" },
  { command: "stop", description: "Stop what the agent is doing in this conversation" },
  { command: "start", description: "Show your user ID and how to use this bot" },
];

const choiceKeyboard = (choices: string[]): TgInlineKeyboard => ({
  inline_keyboard: choices.map((text, i) => [{ text, callback_data: `${CHOICE_PREFIX}${i}` }]),
});

const isParseError = (err: unknown) =>
  err instanceof TelegramError && err.code === 400 && /pars|entit|tag/i.test(err.message);

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
  // sendMessageDraft shows the status as a draft bubble; if Telegram refuses it, use "typing…".
  let draftsWork = true;
  let nextDraftId = 1;

  const sendHtml = async (
    chatId: number,
    threadId: number | undefined,
    markdown: string,
    extra: object = {},
  ): Promise<TgMessage> => {
    const params = { chat_id: chatId, message_thread_id: threadId, ...extra };
    try {
      return await api.call<TgMessage>("sendMessage", {
        ...params,
        text: toTelegramHtml(markdown, nameOf),
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      // Formatting Telegram rejects should never lose the reply: send it as plain text.
      if (!isParseError(err)) throw err;
      return api.call<TgMessage>("sendMessage", { ...params, text: markdown });
    }
  };

  const replyTo = (target: ReplyTarget): Reply => {
    const chatId = chatIdOf(target.channel);
    if (chatId === null) throw new Error(`not a Telegram channel: ${target.channel}`);
    let threadId = target.threadTs ? Number(target.threadTs) : undefined;
    const messageId = target.ts ? Number(target.ts) : undefined;
    const draftId = nextDraftId++;
    let statusTimer: ReturnType<typeof setInterval> | undefined;
    const stopStatus = () => {
      clearInterval(statusTimer);
      statusTimer = undefined;
    };
    const setReaction = async (emoji: string[]) => {
      if (messageId === undefined) return;
      await api
        .call("setMessageReaction", {
          chat_id: chatId,
          message_id: messageId,
          reaction: emoji.map((e) => ({ type: "emoji", emoji: e })),
        })
        .catch(() => {});
    };

    /** Send files one by one; one that can't be sent is reported in the chat instead. */
    const sendFiles = async (files: OutgoingFile[]) => {
      for (const file of files) {
        const size = Bun.file(file.path).size;
        const params = { chat_id: chatId, message_thread_id: threadId };
        try {
          if (size > MAX_UPLOAD_BYTES) {
            throw new Error(`larger than Telegram's ${formatSize(MAX_UPLOAD_BYTES)} limit`);
          }
          if (isPhotoFile(file.name, size)) {
            // Telegram refuses some images as photos (odd dimensions): send those as files.
            const sent = await api.upload("sendPhoto", params, "photo", file).then(
              () => true,
              () => false,
            );
            if (sent) continue;
          }
          await api.upload("sendDocument", params, "document", file);
        } catch (err) {
          logger.warn(`telegram: could not send ${file.name}: ${(err as Error).message}`);
          await sendHtml(
            chatId,
            threadId,
            `_Could not send \`${file.name}\`: ${(err as Error).message}_`,
          ).catch(() => {});
        }
      }
    };

    return {
      async post(markdown, choices = [], files = []) {
        stopStatus();
        // A scheduled run's result opens a topic of its own, where the user can follow up.
        let topic: string | undefined;
        if (target.startsThread && threadId === undefined && identity.topicsEnabled) {
          const created = await api
            .call<TgForumTopic>("createForumTopic", {
              chat_id: chatId,
              name: plainLine(markdown, 60) || "elseagent",
            })
            .catch((err: Error) => {
              logger.warn(`telegram: could not create a topic: ${err.message}`);
              return null;
            });
          if (created) {
            threadId = created.message_thread_id;
            topic = String(threadId);
          }
        }
        const parts = replyParts(markdown, files.length > 0, TELEGRAM_MARKDOWN_LIMIT);
        let first: string | undefined;
        for (const [i, part] of parts.entries()) {
          const keyboard =
            i === parts.length - 1 && choices.length > 0
              ? { reply_markup: choiceKeyboard(choices) }
              : {};
          const sent = await sendHtml(chatId, threadId, part, keyboard);
          first ??= String(sent.message_id);
        }
        await sendFiles(files);
        // Without topics there is no new conversation to continue.
        return target.startsThread ? topic : first;
      },
      async react(name) {
        await setReaction([REACTION_EMOJI[name]]);
      },
      async unreact() {
        // A bot has at most one reaction per message: removing one clears it.
        await setReaction([]);
      },
      async setStatus(status) {
        stopStatus();
        // Nothing to clear: the draft goes away when we post (or after 30 s), typing after 5 s.
        if (!status) return;
        const text = toTelegramHtml(`_${statusText(status)}_`);
        const show = async () => {
          if (draftsWork) {
            try {
              await api.call("sendMessageDraft", {
                chat_id: chatId,
                message_thread_id: threadId,
                draft_id: draftId,
                text,
                parse_mode: "HTML",
              });
              return;
            } catch (err) {
              if (!(err instanceof TelegramError) || err.code !== 400) return;
              logger.warn(
                `telegram: drafts unavailable, showing "typing…" instead: ${err.message}`,
              );
              draftsWork = false;
            }
          }
          await api
            .call("sendChatAction", {
              chat_id: chatId,
              message_thread_id: threadId,
              action: "typing",
            })
            .catch(() => {});
        };
        await show();
        statusTimer = setInterval(
          () => void show(),
          draftsWork ? DRAFT_REFRESH_MS : TYPING_REFRESH_MS,
        );
      },
    };
  };

  const albums = new Map<
    string,
    { messages: IncomingMessage[]; timer?: ReturnType<typeof setTimeout> }
  >();

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
      const key = `${m.chat.id}:${m.media_group_id}`;
      const album = albums.get(key) ?? { messages: [] };
      albums.set(key, album);
      album.messages.push(message);
      clearTimeout(album.timer);
      album.timer = setTimeout(() => {
        albums.delete(key);
        const merged = mergeAlbum(album.messages);
        if (merged) void dispatch(onMessage, merged);
      }, albumWaitMs);
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
      for (const album of albums.values()) clearTimeout(album.timer);
      await polling;
    },
  };
}
