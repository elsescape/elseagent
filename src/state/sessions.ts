import { and, desc, eq, inArray, lt, ne, notInArray, sql } from "drizzle-orm";
import { countWhere, type StateDb } from "./db.ts";
import { codexThreads, sessions } from "./schema.ts";

export interface SessionInfo {
  /** Null right after `/new`: the next turn starts a new Codex thread. */
  threadId: string | null;
  /** ID (ts) of the last message Codex has seen in this conversation. */
  lastSeenTs: string | null;
}

/** Whether and how the agent follows a Slack thread (see agent/follow.ts). */
export interface FollowState {
  muted: boolean;
  /** Unix epoch ms the agent was last mentioned or replied; null if never. */
  lastAddressedAt: number | null;
  /** Unix epoch ms of the last turn. */
  lastActiveAt: number;
  /** Messages since the agent's last reply. */
  unanswered: number;
  /** Who the agent's last reply answered. */
  repliedTo: string | null;
}

/** Stored as the thread id of a session without a Codex thread yet (the column is NOT NULL). */
const NO_THREAD = "";
const hasThread = ne(sessions.threadId, NO_THREAD);

/** Maps a conversation to the Codex thread that holds its context. */
export class SessionStore {
  constructor(
    private readonly db: StateDb,
    private readonly now: () => number = Date.now,
  ) {}

  /** The conversation's session, unless it has been idle longer than `maxIdleMs`. */
  get(conversationKey: string, maxIdleMs: number): SessionInfo | null {
    const row = this.db
      .select()
      .from(sessions)
      .where(eq(sessions.conversationKey, conversationKey))
      .get();
    if (!row || row.lastActiveAt < this.now() - maxIdleMs) return null;
    return { threadId: row.threadId || null, lastSeenTs: row.lastSeenTs };
  }

  /** Record a turn: the Codex thread the conversation uses and the last message it saw. */
  touch(conversationKey: string, threadId: string, lastSeenTs: string | null = null): void {
    const lastActiveAt = this.now();
    this.db.transaction((tx) => {
      tx.insert(sessions)
        .values({ conversationKey, threadId, lastActiveAt, lastSeenTs })
        .onConflictDoUpdate({
          target: sessions.conversationKey,
          set: { threadId, lastActiveAt, lastSeenTs },
        })
        .run();
      if (threadId) this.upsertThread(tx, threadId, conversationKey, lastActiveAt);
    });
  }

  /**
   * Remember a Codex thread no conversation maps to (a scheduled run that stayed silent), so
   * cleanup deletes it once it is old.
   */
  trackThread(threadId: string, conversationKey: string): void {
    this.upsertThread(this.db, threadId, conversationKey, this.now());
  }

  private upsertThread(
    db: Pick<StateDb, "insert">,
    threadId: string,
    conversationKey: string,
    lastUsedAt: number,
  ): void {
    db.insert(codexThreads)
      .values({ threadId, conversationKey, lastUsedAt })
      .onConflictDoUpdate({
        target: codexThreads.threadId,
        set: { conversationKey, lastUsedAt },
      })
      .run();
  }

  /**
   * Start a conversation over (`/new`): its next turn gets a new Codex thread. `fromTs` keeps
   * earlier thread messages out of the new session's context.
   */
  reset(conversationKey: string, fromTs: string | null): void {
    this.touch(conversationKey, NO_THREAD, fromTs);
  }

  /** The thread's follow state, or null if the agent has no session there. */
  followState(conversationKey: string): FollowState | null {
    const row = this.db
      .select({
        muted: sessions.muted,
        lastAddressedAt: sessions.lastAddressedAt,
        lastActiveAt: sessions.lastActiveAt,
        unanswered: sessions.unanswered,
        repliedTo: sessions.repliedTo,
      })
      .from(sessions)
      .where(eq(sessions.conversationKey, conversationKey))
      .get();
    return row ?? null;
  }

  /**
   * The agent was mentioned in a conversation: make sure it has a session row, so follow-ups are
   * followed even before the first turn ends, and note the time.
   */
  addressed(conversationKey: string): void {
    this.address(conversationKey, {});
  }

  /**
   * Mute a thread (only reply there when mentioned) or follow it again. Asking is addressing
   * the agent, so the thread gets a session to hold the setting if it has none.
   */
  mute(conversationKey: string, muted: boolean): void {
    this.address(conversationKey, { muted });
  }

  private address(conversationKey: string, change: { muted?: boolean }): void {
    const now = this.now();
    this.db
      .insert(sessions)
      .values({
        conversationKey,
        threadId: NO_THREAD,
        lastActiveAt: now,
        lastAddressedAt: now,
        ...change,
      })
      .onConflictDoUpdate({
        target: sessions.conversationKey,
        set: { lastAddressedAt: now, ...change },
      })
      .run();
  }

  /** The agent replied to `user` here: the thread is answered. */
  replied(conversationKey: string, user: string): void {
    this.db
      .update(sessions)
      .set({ lastAddressedAt: this.now(), unanswered: 0, repliedTo: user })
      .where(eq(sessions.conversationKey, conversationKey))
      .run();
  }

  /** Someone wrote in the thread without the agent replying (yet). */
  noteUnanswered(conversationKey: string): void {
    this.db
      .update(sessions)
      .set({ unanswered: sql`${sessions.unanswered} + 1` })
      .where(eq(sessions.conversationKey, conversationKey))
      .run();
  }

  /** Most recently active sessions first. */
  list(limit = 20): {
    conversationKey: string;
    threadId: string;
    lastActiveAt: number;
    muted: boolean;
    unanswered: number;
  }[] {
    return this.db
      .select({
        conversationKey: sessions.conversationKey,
        threadId: sessions.threadId,
        lastActiveAt: sessions.lastActiveAt,
        muted: sessions.muted,
        unanswered: sessions.unanswered,
      })
      .from(sessions)
      .where(hasThread) // not ones just reset with /new
      .orderBy(desc(sessions.lastActiveAt))
      .limit(limit)
      .all();
  }

  count(): number {
    return countWhere(this.db, sessions, hasThread);
  }

  /** Drop one conversation's session; its next message starts a new Codex session. */
  forget(conversationKey: string): boolean {
    return (
      this.db
        .delete(sessions)
        .where(eq(sessions.conversationKey, conversationKey))
        .returning({ key: sessions.conversationKey })
        .all().length > 0
    );
  }

  /**
   * Conversations idle since before `cutoff` (epoch ms), oldest first, except `keep` (e.g. ones
   * with queued messages). Their Codex thread is empty when there is none.
   */
  idleSince(cutoff: number, keep: string[] = []): { conversationKey: string; threadId: string }[] {
    return this.db
      .select({ conversationKey: sessions.conversationKey, threadId: sessions.threadId })
      .from(sessions)
      .where(and(lt(sessions.lastActiveAt, cutoff), notInArray(sessions.conversationKey, keep)))
      .orderBy(sessions.lastActiveAt)
      .all();
  }

  /** Delete sessions (no turn may be running in them). */
  deleteSessions(conversationKeys: string[]): void {
    if (conversationKeys.length === 0) return;
    this.db.delete(sessions).where(inArray(sessions.conversationKey, conversationKeys)).run();
  }

  /**
   * Codex threads last used before `cutoff` that no remaining session maps to: they can be
   * deleted from Codex's storage.
   */
  unusedThreads(cutoff: number): { threadId: string; conversationKey: string }[] {
    const mapped = this.db.select({ id: sessions.threadId }).from(sessions);
    return this.db
      .select({ threadId: codexThreads.threadId, conversationKey: codexThreads.conversationKey })
      .from(codexThreads)
      .where(and(lt(codexThreads.lastUsedAt, cutoff), notInArray(codexThreads.threadId, mapped)))
      .orderBy(codexThreads.lastUsedAt)
      .all();
  }

  /** The Codex thread was deleted from Codex's storage: stop tracking it. */
  dropThread(threadId: string): void {
    this.db.delete(codexThreads).where(eq(codexThreads.threadId, threadId)).run();
  }

  /** Conversation keys that still have a session. */
  conversationKeys(): string[] {
    return this.db
      .select({ key: sessions.conversationKey })
      .from(sessions)
      .all()
      .map((r) => r.key);
  }

  /** Forget sessions idle longer than `maxIdleMs`. Returns how many were removed. */
  expire(maxIdleMs: number): number {
    return this.db
      .delete(sessions)
      .where(lt(sessions.lastActiveAt, this.now() - maxIdleMs))
      .returning({ key: sessions.conversationKey })
      .all().length;
  }
}
