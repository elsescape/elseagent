import type { Fetch } from "../types.ts";

/**
 * A minimal Telegram Bot API client: the few methods and fields elseagent uses.
 * https://core.telegram.org/bots/api
 */

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  /** getMe only: the bot has topics (threaded mode) enabled in private chats. */
  has_topics_enabled?: boolean;
}

export interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
}

export interface TgInlineButton {
  text: string;
  callback_data?: string;
}

export interface TgInlineKeyboard {
  inline_keyboard: TgInlineButton[][];
}

/** A file in a message: a document, video, audio or voice note, or one size of a photo. */
export interface TgFile {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TgMessage {
  message_id: number;
  /** The topic the message belongs to (forum topics, and private chats with topics). */
  message_thread_id?: number;
  is_topic_message?: boolean;
  from?: TgUser;
  chat: TgChat;
  text?: string;
  caption?: string;
  reply_markup?: TgInlineKeyboard;
  /** Set on each message of an album (photos or files sent together). */
  media_group_id?: string;
  document?: TgFile;
  /** The same photo in several sizes, smallest first. */
  photo?: TgFile[];
  video?: TgFile;
  audio?: TgFile;
  voice?: TgFile;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface TgForumTopic {
  message_thread_id: number;
  name: string;
}

/** An error response from the Bot API. */
export class TelegramError extends Error {
  override name = "TelegramError";
  constructor(
    readonly method: string,
    readonly code: number,
    description: string,
    readonly retryAfter?: number,
  ) {
    super(`${method}: ${description}`);
  }
}

/** A file to upload: its path on disk and the name shown in the chat. */
export interface TgUpload {
  path: string;
  name: string;
}

/** Longest wait for a rate limit (429) before giving up on a call. */
const MAX_RETRY_AFTER_S = 60;

export class TelegramApi {
  private readonly base: string;
  private readonly files: string;

  constructor(
    token: string,
    private readonly fetchImpl: Fetch = fetch,
    baseUrl = "https://api.telegram.org",
  ) {
    this.base = `${baseUrl}/bot${token}`;
    this.files = `${baseUrl}/file/bot${token}`;
  }

  /** Call a Bot API method. A rate-limited call (429) is retried once after the given wait. */
  call<T>(method: string, params: object = {}, signal?: AbortSignal): Promise<T> {
    return this.retrying(() =>
      this.request<T>(method, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal,
      }),
    );
  }

  /** Call a method that sends a file (sendDocument, sendPhoto): `field` holds the file. */
  upload<T>(method: string, params: object, field: string, file: TgUpload): Promise<T> {
    return this.retrying(() => {
      const form = new FormData();
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined) continue;
        form.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
      }
      form.set(field, Bun.file(file.path), file.name);
      return this.request<T>(method, { body: form });
    });
  }

  /** Download a file by its file_id (bots can download files up to 20 MB). */
  async downloadFile(fileId: string, dest: string, signal?: AbortSignal): Promise<void> {
    const file = await this.call<{ file_path?: string }>("getFile", { file_id: fileId }, signal);
    if (!file.file_path) throw new Error("Telegram gave no file path");
    const res = await this.fetchImpl(`${this.files}/${file.file_path}`, { method: "GET", signal });
    if (!res.ok) throw new Error(`Telegram answered HTTP ${res.status}`);
    await Bun.write(dest, res);
  }

  private async retrying<T>(attempt: () => Promise<T>): Promise<T> {
    try {
      return await attempt();
    } catch (err) {
      if (
        err instanceof TelegramError &&
        err.code === 429 &&
        err.retryAfter !== undefined &&
        err.retryAfter <= MAX_RETRY_AFTER_S
      ) {
        await Bun.sleep(err.retryAfter * 1000);
        return attempt();
      }
      throw err;
    }
  }

  private async request<T>(method: string, init: RequestInit): Promise<T> {
    const res = await this.fetchImpl(`${this.base}/${method}`, { method: "POST", ...init });
    const body = (await res.json().catch(() => null)) as {
      ok: boolean;
      result?: T;
      error_code?: number;
      description?: string;
      parameters?: { retry_after?: number };
    } | null;
    if (!body?.ok) {
      throw new TelegramError(
        method,
        body?.error_code ?? res.status,
        body?.description ?? `HTTP ${res.status}`,
        body?.parameters?.retry_after,
      );
    }
    return body.result as T;
  }
}
