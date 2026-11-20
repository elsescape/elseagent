import type { ThreadEvent } from "@openai/codex-sdk";
import { MINUTE_MS } from "../util/time.ts";

export type TurnStatus = "completed" | "failed" | "interrupted";

/** A file attached to a message or sent with a reply. */
export interface EventFile {
  name: string;
  /**
   * Where it is: relative to the agent's workspace, from which `GET /api/files` serves it, or
   * absolute when the agent put it somewhere else (it can't be downloaded then).
   */
  path: string;
}

/** A file as an upload returns it: where it was saved, and what it is. */
export interface UploadedFile extends EventFile {
  /** In bytes. */
  size: number;
  mimetype?: string;
}

/** Whether a session has a turn running, a message waiting for one, or neither. */
export type SessionStatus = "running" | "queued" | "idle";

/**
 * What happens in an API chat session, in order. One user message leads to one turn:
 * `user_message`, `turn_started`, then `codex` events (Codex's own, unchanged) and `status`
 * lines while it works, the `reply` posted to the chat, and `turn_ended`.
 *
 * Codex's last `agent_message` item is the reply as JSON (see REPLY_SCHEMA); `reply` is that
 * message parsed, or a notice from elseagent itself (a timeout, a stop).
 */
export type SessionEventBody =
  | { type: "user_message"; text: string; user: string; files: EventFile[] }
  | { type: "turn_started" }
  | { type: "codex"; event: ThreadEvent }
  | { type: "status"; text: string }
  | { type: "reply"; text: string; choices: string[]; files: EventFile[] }
  | { type: "turn_ended"; status: TurnStatus };

export type SessionEvent = SessionEventBody & {
  /** The user message whose turn this belongs to; empty outside a turn. */
  messageId: string;
  /** Unix epoch milliseconds. */
  at: number;
};

/** An event of a turn in progress, numbered so a stream can be resumed after it. */
export type LiveEvent = SessionEvent & { seq: number };

interface Stream {
  events: LiveEvent[];
  /** Messages whose turn has not ended, and when it started (null while queued). */
  open: Map<string, number | null>;
  listeners: Set<(event: LiveEvent) => void>;
  /** Unix epoch ms since nothing was open; null while a turn is. */
  idleSince: number | null;
}

interface EventHubOptions {
  /** Events kept per session; older ones are dropped. */
  maxEvents?: number;
  /** How long a finished turn's events stay available to a stream resuming after a cursor. */
  retainMs?: number;
  now?: () => number;
}

/**
 * The live events of API sessions, in memory. It only holds turns that are queued or running
 * (and, briefly, just ended): finished turns are read back from Codex's own history.
 */
export class EventHub {
  /** Changes with every process, so a cursor from before a restart is recognized as stale. */
  readonly epoch = crypto.randomUUID().slice(0, 8);
  private seq = 0;
  private readonly streams = new Map<string, Stream>();
  private readonly maxEvents: number;
  private readonly retainMs: number;
  private readonly now: () => number;

  constructor({
    maxEvents = 5000,
    retainMs = 5 * MINUTE_MS,
    now = Date.now,
  }: EventHubOptions = {}) {
    this.maxEvents = maxEvents;
    this.retainMs = retainMs;
    this.now = now;
  }

  /** The position after the last published event; `subscribe` resumes from it. */
  get cursor(): string {
    return `${this.epoch}:${this.seq}`;
  }

  publish(sessionId: string, messageId: string, body: SessionEventBody): LiveEvent {
    this.sweep();
    const stream = this.stream(sessionId);
    const event: LiveEvent = { ...body, messageId, at: this.now(), seq: ++this.seq };
    if (body.type === "user_message") {
      // Earlier turns are in Codex's history by now.
      if (stream.open.size === 0) stream.events = [];
      if (!stream.open.has(messageId)) stream.open.set(messageId, null);
      stream.idleSince = null;
    } else if (body.type === "turn_started") {
      stream.open.set(messageId, event.at);
      stream.idleSince = null;
    }
    stream.events.push(event);
    if (stream.events.length > this.maxEvents) {
      stream.events.splice(0, stream.events.length - this.maxEvents);
    }
    if (body.type === "turn_ended") {
      stream.open.delete(messageId);
      if (stream.open.size === 0) stream.idleSince = this.now();
    }
    for (const listener of stream.listeners) listener(event);
    return event;
  }

  /** Whether a message's turn has been announced and has not ended. */
  has(sessionId: string, messageId: string): boolean {
    return this.streams.get(sessionId)?.open.has(messageId) ?? false;
  }

  /**
   * When the session's running turn started (Unix epoch ms); undefined when none is running.
   * Whatever Codex recorded from then on belongs to the live events, not to history.
   */
  runningSince(sessionId: string): number | undefined {
    const started = [...(this.streams.get(sessionId)?.open.values() ?? [])].filter(
      (at) => at !== null,
    );
    return started.length ? Math.min(...started) : undefined;
  }

  /** The events of the session's turns that have not ended. */
  live(sessionId: string): LiveEvent[] {
    const stream = this.streams.get(sessionId);
    if (!stream) return [];
    return stream.events.filter((e) => stream.open.has(e.messageId));
  }

  /**
   * Deliver the session's events to `listener` from now on, after replaying what it missed:
   * everything after `cursor` when it is one of ours, else the turns still in progress.
   */
  subscribe(
    sessionId: string,
    cursor: string | undefined,
    listener: (event: LiveEvent) => void,
  ): () => void {
    const stream = this.stream(sessionId);
    const after = this.parseCursor(cursor);
    const missed =
      after === undefined ? this.live(sessionId) : stream.events.filter((e) => e.seq > after);
    for (const event of missed) listener(event);
    stream.listeners.add(listener);
    return () => {
      stream.listeners.delete(listener);
    };
  }

  /** Forget a session (it was deleted). Its streams stop receiving events. */
  drop(sessionId: string): void {
    this.streams.delete(sessionId);
  }

  private parseCursor(cursor: string | undefined): number | undefined {
    const [epoch, seq] = cursor?.split(":") ?? [];
    const n = Number(seq);
    return epoch === this.epoch && seq && Number.isInteger(n) && n >= 0 ? n : undefined;
  }

  private stream(sessionId: string): Stream {
    let stream = this.streams.get(sessionId);
    if (!stream) {
      stream = { events: [], open: new Map(), listeners: new Set(), idleSince: this.now() };
      this.streams.set(sessionId, stream);
    }
    return stream;
  }

  /** Drop the buffers of sessions nobody is watching and nothing is running in. */
  private sweep(): void {
    const cutoff = this.now() - this.retainMs;
    for (const [id, stream] of this.streams) {
      if (stream.idleSince === null || stream.idleSince > cutoff) continue;
      if (stream.listeners.size === 0) this.streams.delete(id);
      else stream.events = [];
    }
  }
}
