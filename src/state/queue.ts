import { and, asc, eq, gt, inArray, lte, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { Attachment } from "../channels/types.ts";
import { countWhere, type StateDb } from "./db.ts";
import { queue } from "./schema.ts";

/** A message waiting for, or being handled by, a Codex turn. */
export interface QueuedMessage {
  id: number;
  conversationKey: string;
  channel: string;
  ts: string;
  threadTs: string | null;
  user: string;
  text: string;
  /** Set for a scheduled run (no chat message to reply to). */
  scheduleId: number | null;
  /** How sure it is the message is for the agent (see the queue table's `mode`). */
  mode: "direct" | "followup" | "passive";
  /** Files attached to the message (not downloaded yet). */
  files: Attachment[];
}

export type NewQueuedMessage = Omit<QueuedMessage, "id" | "scheduleId" | "mode" | "files"> & {
  scheduleId?: number | null;
  mode?: QueuedMessage["mode"];
  files?: Attachment[];
};

const columns = {
  id: queue.id,
  conversationKey: queue.conversationKey,
  channel: queue.channel,
  ts: queue.ts,
  threadTs: queue.threadTs,
  user: queue.user,
  text: queue.text,
  scheduleId: queue.scheduleId,
  mode: queue.mode,
  files: queue.files,
};

/**
 * Persistent FIFO buffer of unanswered messages. Rows are removed when their turn ends.
 * A conversation never has two messages running at once, so its turns happen in order.
 */
export class MessageQueue {
  constructor(private readonly db: StateDb) {}

  push(message: NewQueuedMessage): QueuedMessage {
    return this.db.insert(queue).values(message).returning(columns).get();
  }

  pendingCount(): number {
    return countWhere(this.db, queue, eq(queue.status, "pending"));
  }

  /** 1-based position among pending messages, oldest first. */
  position(id: number): number {
    return countWhere(this.db, queue, and(eq(queue.status, "pending"), lte(queue.id, id)));
  }

  /**
   * Atomically take the next pending message whose conversation has nothing running, and mark
   * it running: passive messages last, oldest first otherwise. Returns null
   * when nothing is eligible.
   */
  claimNext(): QueuedMessage | null {
    const running = alias(queue, "running");
    const next = this.db
      .select({ id: queue.id })
      .from(queue)
      .where(
        and(
          eq(queue.status, "pending"),
          notExists(
            this.db
              .select({ one: sql`1` })
              .from(running)
              .where(
                and(
                  eq(running.status, "running"),
                  eq(running.conversationKey, queue.conversationKey),
                ),
              ),
          ),
        ),
      )
      .orderBy(sql`${queue.mode} = 'passive'`, asc(queue.id))
      .limit(1);
    return (
      this.db
        .update(queue)
        .set({ status: "running" })
        .where(inArray(queue.id, next))
        .returning(columns)
        .get() ?? null
    );
  }

  /** Whether a later message of the conversation is waiting (it will see this one as context). */
  hasNewerPending(conversationKey: string, id: number): boolean {
    return (
      this.db
        .select({ id: queue.id })
        .from(queue)
        .where(
          and(
            eq(queue.conversationKey, conversationKey),
            eq(queue.status, "pending"),
            gt(queue.id, id),
          ),
        )
        .limit(1)
        .get() !== undefined
    );
  }

  /** Conversations with a message waiting or running. */
  conversations(): string[] {
    return this.db
      .selectDistinct({ key: queue.conversationKey })
      .from(queue)
      .all()
      .map((r) => r.key);
  }

  /** Pending messages, oldest first. */
  listPending(limit = 50): QueuedMessage[] {
    return this.db
      .select(columns)
      .from(queue)
      .where(eq(queue.status, "pending"))
      .orderBy(asc(queue.id))
      .limit(limit)
      .all();
  }

  /** Drop a message that has not started yet. Returns it, or null if it is not pending. */
  removePending(id: number): QueuedMessage | null {
    return (
      this.db
        .delete(queue)
        .where(and(eq(queue.id, id), eq(queue.status, "pending")))
        .returning(columns)
        .get() ?? null
    );
  }

  /** The turn for this message ended (answered, failed or timed out): drop it. */
  remove(id: number): void {
    this.db.delete(queue).where(eq(queue.id, id)).run();
  }

  /**
   * Messages still marked running belong to a previous process that stopped mid-turn. Remove
   * and return them so the users can be told. They are not retried automatically, because the
   * interrupted turn may already have changed files.
   */
  takeInterrupted(): QueuedMessage[] {
    return this.db.delete(queue).where(eq(queue.status, "running")).returning(columns).all();
  }
}
