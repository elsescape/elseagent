import type { KnownEventFromType, types } from "@slack/bolt";
import { type Attachment, type IncomingMessage, type Reaction, STOP_COMMAND } from "../types.ts";

type AppMentionEvent = types.AppMentionEvent;

type MessageEvent = KnownEventFromType<"message">;

/** The emoji name of each reaction. */
export const REACTION_NAMES: Record<Reaction, string> = {
  queued: "hourglass_flowing_sand",
  working: "eyes",
  failed: "x",
};

/** Slack DM channel IDs start with D. */
export const isDm = (channel: string) => channel.startsWith("D");

/** Ignore redelivery of recent Slack messages, including delivery through both subscriptions. */
export function deduplicateMessages(dispatch: (message: IncomingMessage) => Promise<void>) {
  const seen = new Set<string>();
  return async (message: IncomingMessage) => {
    const key = `${message.channel}:${message.ts}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 1_000) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    await dispatch(message);
  };
}

/** The fields of a Slack file object we use. */
export interface SlackFile {
  name?: string | null;
  title?: string | null;
  mimetype?: string;
  size?: number;
  mode?: string;
  url_private_download?: string;
  url_private?: string;
}

/**
 * Attachments of a Slack message. Files without a download URL (deleted, external, hidden by
 * the workspace's plan) are left out.
 */
export function slackFiles(files: SlackFile[] | undefined): Attachment[] {
  const out: Attachment[] = [];
  for (const f of files ?? []) {
    const ref = f.url_private_download ?? f.url_private;
    if (!ref || f.mode === "tombstone" || f.mode === "hidden_by_limit") continue;
    out.push({ name: f.name || f.title || "file", mimetype: f.mimetype, size: f.size, ref });
  }
  return out;
}

/** `files` only when there are some, so messages without files look as they did. */
const withFiles = (files: SlackFile[] | undefined) => {
  const list = slackFiles(files);
  return list.length > 0 ? { files: list } : {};
};

/** Plain messages and messages sharing files; edits, joins, bot messages etc. are ignored. */
const isUserMessage = (event: MessageEvent) =>
  event.subtype === undefined || event.subtype === "file_share";

const filesOf = (event: MessageEvent): SlackFile[] | undefined =>
  "files" in event ? (event.files as SlackFile[] | undefined) : undefined;

export function stripMention(text: string, botUserId: string): string {
  return text.replaceAll(`<@${botUserId}>`, "").replace(/\s+/g, " ").trim();
}

/** An @mention of the agent in a channel. Ignores other bots. */
export function fromMention(event: AppMentionEvent, botUserId: string): IncomingMessage | null {
  if (!event.user || event.bot_id || event.user === botUserId) return null;
  return {
    channel: event.channel,
    ts: event.ts,
    threadTs: event.thread_ts ?? event.ts,
    user: event.user,
    text: stripMention(event.text, botUserId),
    isDirect: false,
    ...withFiles(event.files),
  };
}

/**
 * A plain user message in a DM with the agent. Channel messages are ignored here:
 * they reach the agent through `app_mention`, which would otherwise be handled twice.
 */
export function fromDirectMessage(event: MessageEvent, botUserId: string): IncomingMessage | null {
  if (!isUserMessage(event) || event.channel_type !== "im") return null;
  if (!("user" in event) || ("bot_id" in event && event.bot_id) || event.user === botUserId) {
    return null;
  }
  return {
    channel: event.channel,
    ts: event.ts,
    threadTs: event.thread_ts,
    user: event.user,
    text: stripMention(event.text ?? "", botUserId),
    isDirect: true,
    ...withFiles(filesOf(event)),
  };
}

/**
 * A reply in a channel thread that doesn't mention the agent: it may be following the thread
 * (see agent/follow.ts). Thread roots, edits, bots and messages mentioning the agent (handled
 * through `app_mention`) are ignored.
 */
export function fromThreadMessage(event: MessageEvent, botUserId: string): IncomingMessage | null {
  if (!isUserMessage(event)) return null;
  if (event.channel_type !== "channel" && event.channel_type !== "group") return null;
  if (!("thread_ts" in event) || !event.thread_ts || event.thread_ts === event.ts) return null;
  if (("bot_id" in event && event.bot_id) || !("user" in event) || !event.user) return null;
  if (event.user === botUserId) return null;
  const text = event.text ?? "";
  if (text.includes(`<@${botUserId}>`)) return null;
  return {
    channel: event.channel,
    ts: event.ts,
    threadTs: event.thread_ts,
    user: event.user,
    text: text.trim(),
    isDirect: false,
    unaddressed: { mentionsOthers: /<@[UW][A-Z0-9]+>/.test(text) },
    ...withFiles(filesOf(event)),
  };
}

/**
 * A click on Slack's stop button (shown while the agent works in a thread), as `!stop` from the
 * user who clicked, in that thread.
 */
export function stopButtonMessage(event: {
  channel: string;
  thread_ts: string;
  user: string;
}): IncomingMessage {
  return {
    channel: event.channel,
    ts: "",
    threadTs: event.thread_ts,
    user: event.user,
    text: STOP_COMMAND,
    isDirect: isDm(event.channel),
  };
}

/** A slash command in a DM, as a message without a Slack message behind it (empty ts). */
export function slashCommandMessage(channel: string, user: string, text: string): IncomingMessage {
  return { channel, ts: "", threadTs: undefined, user, text, isDirect: true };
}
