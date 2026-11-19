import type { ToolGroup } from "../mcp/tools.ts";

/**
 * The interface every channel (Slack, Telegram) implements. Messages, replies and schedules carry
 * a `channel` string, the chat ID within a channel: a Slack channel or DM ID, or `tg:<chat id>`.
 * Each channel owns its own chat IDs, so one queue, session store and scheduler serve all of them.
 */

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

/** The part of `fetch` the channels use (tests pass a fake). */
export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** Prefix of Telegram channel IDs (`tg:<chat id>`); Slack IDs are used as they are. */
export const TELEGRAM_PREFIX = "tg:";
/** Prefix of the HTTP API's chat IDs (`api:chat`, see src/api/channel.ts). */
export const API_PREFIX = "api:";

/**
 * Commands a channel hands to the agent as message text: its slash commands and stop button
 * arrive as these, so the agent handles them like typed ones.
 */
/** Start the conversation over. Only a message without a chat message behind it (empty `ts`). */
export const NEW_SESSION_COMMAND = "/new";
/** Stop the turn running in the conversation. */
export const STOP_COMMAND = "!stop";

/**
 * Where a message stands, shown as a reaction on it; each channel picks the emoji. A successful
 * turn just removes "working": the reply itself says it's done.
 */
export type Reaction = "queued" | "working" | "failed";

/** A file attached to a message, not downloaded yet (see `Channel.download`). */
export interface Attachment {
  name: string;
  mimetype?: string;
  /** In bytes, when the platform says. */
  size?: number;
  /** How the channel fetches it: a Slack download URL, a Telegram file_id. */
  ref: string;
}

/** A file the agent sends along with a reply. */
export interface OutgoingFile {
  /** Absolute path on disk. */
  path: string;
  /** File name shown in the chat. */
  name: string;
}

/** A message addressed to the agent, normalized from a platform event. */
export interface IncomingMessage {
  channel: string;
  /** ID of the message itself (used for reactions); empty for slash commands. */
  ts: string;
  /**
   * Thread to reply in: a Slack thread, or a Telegram topic. Undefined for a DM's top level,
   * which is one conversation.
   */
  threadTs: string | undefined;
  user: string;
  /** Text with the agent's own @mention removed. */
  text: string;
  isDirect: boolean;
  /** Files attached to the message (images, documents…). */
  files?: Attachment[];
  /**
   * Set for a thread message that doesn't mention the agent (Slack channel threads): whether
   * the agent answers depends on whether it follows the thread. Absent: addressed to the agent.
   */
  unaddressed?: { mentionsOthers: boolean };
}

/**
 * Identifies the conversation a message belongs to, which maps to one Codex session:
 * a thread (`channel:threadTs`), or a DM's top level (`channel`).
 */
export function conversationKey(message: Pick<IncomingMessage, "channel" | "threadTs">): string {
  return message.threadTs ? `${message.channel}:${message.threadTs}` : message.channel;
}

/** Where a reply goes: the conversation of a message, and the message itself for reactions. */
export interface ReplyTarget {
  channel: string;
  /** The message to react to; empty when there is none. */
  ts: string;
  /** Thread to post in; undefined/null posts top-level. */
  threadTs?: string | null;
  /**
   * The reply starts a conversation of its own (a scheduled run's result). Slack posts it
   * top-level, where it starts a thread anyway; Telegram opens a new topic for it.
   */
  startsThread?: boolean;
}

/** Ways to respond to a message. */
export interface Reply {
  /**
   * Post Markdown in the conversation, split into several messages if it is long. With
   * `choices`, the last message shows them as buttons; a click arrives as a new message.
   * With `files`, they are uploaded after the text, in the same conversation; a file that can't
   * be sent is reported there instead. Returns the ID of the thread a reply there would
   * continue, when the post started one (a Slack message ts, a Telegram topic), else the first
   * message's ID or undefined.
   */
  post(markdown: string, choices?: string[], files?: OutgoingFile[]): Promise<string | undefined>;
  /** Mark the message with a reaction. Errors are ignored. */
  react(reaction: Reaction): Promise<void>;
  /** Remove one of our reactions from the message. Errors are ignored. */
  unreact(reaction: Reaction): Promise<void>;
  /**
   * Show what the agent is doing ("is running tests…"); empty clears it. It also goes away
   * when we post. Errors are ignored.
   */
  setStatus(status: string): Promise<void>;
}

export type MessageHandler = (message: IncomingMessage, reply: Reply) => Promise<void>;

/** A message from the thread that was not addressed to the agent. */
export interface ContextMessage {
  user: string;
  text: string;
  files?: Attachment[];
}

export interface ThreadContext {
  messages: ContextMessage[];
  /** How many earlier messages were left out to keep the context short. */
  omitted: number;
}

export const NO_CONTEXT: ThreadContext = { messages: [], omitted: 0 };

/** A source that delivers platform events as normalized agent messages. */
export interface IncomingChannel {
  readonly platform: string;
  /** Shown in logs, e.g. "slack @reviewer (U0123)". */
  readonly label: string;
  /** Connect and start delivering messages to `onMessage`. */
  start(onMessage: MessageHandler): Promise<void>;
  stop(): Promise<void>;
}

/** A chat adapter that can also address replies to persisted messages and schedules. */
export interface Channel extends IncomingChannel {
  /** Stable, filename-safe identity used when this is the agent's primary channel. */
  readonly stateKey: string;
  /** Channel-specific MCP tools, registered only while this adapter is enabled. */
  readonly registerMcpTools?: ToolGroup;
  /** What Codex is told about conversations in this channel (formatting, threads, schedules). */
  instructions: string;
  /** Whether a chat ID (a message's `channel`) belongs to this channel. */
  owns(channel: string): boolean;
  /** Reply to a message, including one received before a restart. */
  replyTo(target: ReplyTarget): Reply;
  /**
   * Messages in the message's thread after `afterTs` (null: from the thread's start) and before
   * the message itself, minus the agent's own. Platforms that can't read history return none.
   */
  threadContext(
    message: { channel: string; ts: string; threadTs: string | null },
    afterTs: string | null,
  ): Promise<ThreadContext>;
  /** Download a file attached to one of this channel's messages to `dest` (a file path). */
  download(file: Attachment, dest: string, signal?: AbortSignal): Promise<void>;
  /** Make sure the agent can post in a channel (name or ID); returns its ID. */
  ensureChannel(ref: string): Promise<string>;
}
