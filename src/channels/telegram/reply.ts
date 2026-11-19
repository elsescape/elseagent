import { formatSize } from "../../util/text.ts";
import { replyParts } from "../markdown.ts";
import type { Logger, OutgoingFile, Reply, ReplyTarget } from "../types.ts";
import {
  type TelegramApi,
  TelegramError,
  type TgForumTopic,
  type TgInlineKeyboard,
  type TgMessage,
} from "./api.ts";
import { plainLine, TELEGRAM_MARKDOWN_LIMIT, toTelegramHtml } from "./format.ts";
import { chatIdOf, isPhotoFile, MAX_UPLOAD_BYTES, REACTION_EMOJI, statusText } from "./message.ts";

/** The Bot API client the channel uses (tests pass a fake). */
export type TelegramClient = Pick<TelegramApi, "call" | "upload" | "downloadFile">;

/** callback_data of a choice button: this prefix and the choice's index. */
export const CHOICE_PREFIX = "choice:";
/** Drafts disappear after 30 s, so a status shown as a draft is re-sent before then. */
const DRAFT_REFRESH_MS = 20_000;
/** "typing…" lasts 5 s. */
const TYPING_REFRESH_MS = 4_000;

const choiceKeyboard = (choices: string[]): TgInlineKeyboard => ({
  inline_keyboard: choices.map((text, i) => [{ text, callback_data: `${CHOICE_PREFIX}${i}` }]),
});

const isParseError = (err: unknown) =>
  err instanceof TelegramError && err.code === 400 && /pars|entit|tag/i.test(err.message);

/** How the bot writes to its chats: plain sends, and the `Reply` for a message or conversation. */
export function createTelegramReplies({
  api,
  logger,
  identity,
  nameOf,
}: {
  api: TelegramClient;
  logger: Logger;
  identity: { topicsEnabled: boolean };
  /** Display names for `<@id>` mentions in replies. */
  nameOf: (userId: string) => string | undefined;
}) {
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

  return { sendHtml, replyTo };
}
