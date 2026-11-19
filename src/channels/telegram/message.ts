import { type Attachment, type IncomingMessage, type Reaction, TELEGRAM_PREFIX } from "../types.ts";
import type { TgFile, TgMessage } from "./api.ts";

/** The channel ID of a Telegram chat. */
export const chatChannel = (chatId: number | string) => `${TELEGRAM_PREFIX}${chatId}`;

/** The Telegram chat ID of a channel, or null if it isn't a Telegram channel. */
export function chatIdOf(channel: string): number | null {
  if (!channel.startsWith(TELEGRAM_PREFIX)) return null;
  const id = Number(channel.slice(TELEGRAM_PREFIX.length));
  return Number.isSafeInteger(id) ? id : null;
}

/** The topic a message is in: each topic of a private chat is its own conversation. */
export const topicOf = (message: TgMessage): string | undefined =>
  message.is_topic_message && message.message_thread_id !== undefined
    ? String(message.message_thread_id)
    : undefined;

/** A bot command at the start of a message, e.g. `/new` or `/start@my_bot payload`. */
export function parseCommand(text: string): { command: string; args: string } | null {
  const match = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match?.[1]) return null;
  return { command: match[1].toLowerCase(), args: match[2]?.trim() ?? "" };
}

/** The files of a message: a document, the largest size of a photo, a video, audio or voice. */
export function telegramFiles(message: TgMessage): Attachment[] {
  const id = message.message_id;
  const file = (f: TgFile | undefined, name: string, mimetype?: string): Attachment[] =>
    f
      ? [
          {
            name: f.file_name ?? name,
            mimetype: f.mime_type ?? mimetype,
            size: f.file_size,
            ref: f.file_id,
          },
        ]
      : [];
  return [
    ...file(message.document, `document-${id}`),
    ...file(message.photo?.at(-1), `photo-${id}.jpg`, "image/jpeg"),
    ...file(message.video, `video-${id}.mp4`, "video/mp4"),
    ...file(message.audio, `audio-${id}.mp3`, "audio/mpeg"),
    ...file(message.voice, `voice-${id}.ogg`, "audio/ogg"),
  ];
}

/**
 * A user's message in a private chat with the bot: text, or a caption with files. Group chats,
 * other bots and messages with neither (stickers, locations…) are ignored.
 */
export function fromTelegramMessage(message: TgMessage): IncomingMessage | null {
  if (message.chat.type !== "private" || !message.from || message.from.is_bot) return null;
  const text = (message.text ?? message.caption ?? "").trim();
  const files = telegramFiles(message);
  if (!text && files.length === 0) return null;
  return {
    channel: chatChannel(message.chat.id),
    ts: String(message.message_id),
    threadTs: topicOf(message),
    user: String(message.from.id),
    text,
    isDirect: true,
    ...(files.length > 0 ? { files } : {}),
  };
}

/**
 * An album (photos or files sent together arrive as one message each) as one message: the
 * first message's place, every caption and every file.
 */
export function mergeAlbum(messages: IncomingMessage[]): IncomingMessage | null {
  const [first] = messages;
  if (!first) return null;
  const text = messages
    .map((m) => m.text)
    .filter(Boolean)
    .join("\n");
  return { ...first, text, files: messages.flatMap((m) => m.files ?? []) };
}

/** Telegram's limits for what a bot sends: photos up to 10 MB, other files up to 50 MB. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Whether a file is sent as a photo (shown inline) rather than as a document. */
export const isPhotoFile = (name: string, size: number) =>
  /\.(jpe?g|png|webp)$/i.test(name) && size <= MAX_PHOTO_BYTES;

/** Telegram allows only a fixed set of reaction emoji. */
export const REACTION_EMOJI: Record<Reaction, string> = {
  queued: "🫡",
  working: "👀",
  failed: "😢",
};

/** The status line as a draft message: "is running `x`…" → "Running `x`…". */
export function statusText(status: string): string {
  const text = status.replace(/^is /, "");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What /start says: the user's ID, and whether they may use the agent. */
export function startText(
  userId: string,
  allowed: boolean,
  { topicsEnabled }: { topicsEnabled: boolean },
): string {
  const id = `Your Telegram user ID is \`${userId}\`.`;
  if (!allowed) {
    return [
      id,
      "",
      "You're not on this agent's allow list yet. Ask whoever runs it to add your ID under " +
        "`channels.telegram.allowedUsers` in its config and restart it, then send me a message.",
    ].join("\n");
  }
  return [
    id,
    "",
    "You're all set: send me a message and I'll get to work.",
    topicsEnabled
      ? "Each topic (thread) in this chat is a separate conversation with its own session; " +
        "start a new topic for something new. `/new` starts the current one over, " +
        "`/stop` stops what I'm doing."
      : "`/new` starts our conversation over with a new session; `/stop` stops what I'm doing.",
  ].join("\n");
}

export const NOT_ALLOWED_TEXT = (userId: string) =>
  `Sorry, you're not on this agent's allow list. Your Telegram user ID is \`${userId}\`; ` +
  "ask whoever runs the agent to add it under `channels.telegram.allowedUsers`.";
