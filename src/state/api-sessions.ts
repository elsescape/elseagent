import { desc, eq } from "drizzle-orm";
import type { StateDb } from "./db.ts";
import { apiSessions } from "./schema.ts";

export interface ApiSession {
  id: string;
  title: string;
  /** Unix epoch milliseconds. */
  createdAt: number;
  updatedAt: number;
}

/** The chat sessions opened through the HTTP API. */
export class ApiSessionStore {
  constructor(
    private readonly db: StateDb,
    private readonly now: () => number = Date.now,
  ) {}

  create(title = ""): ApiSession {
    const now = this.now();
    return this.db
      .insert(apiSessions)
      .values({ id: crypto.randomUUID(), title, createdAt: now, updatedAt: now })
      .returning()
      .get();
  }

  get(id: string): ApiSession | null {
    return this.db.select().from(apiSessions).where(eq(apiSessions.id, id)).get() ?? null;
  }

  /** Most recently active first. */
  list(limit = 100): ApiSession[] {
    return this.db
      .select()
      .from(apiSessions)
      .orderBy(desc(apiSessions.updatedAt), desc(apiSessions.createdAt))
      .limit(limit)
      .all();
  }

  rename(id: string, title: string): ApiSession | null {
    return (
      this.db.update(apiSessions).set({ title }).where(eq(apiSessions.id, id)).returning().get() ??
      null
    );
  }

  /** Something happened in the session. `title` names it if it has no title yet. */
  touch(id: string, title = ""): void {
    const session = this.get(id);
    if (!session) return;
    this.db
      .update(apiSessions)
      .set({ updatedAt: this.now(), title: session.title || title })
      .where(eq(apiSessions.id, id))
      .run();
  }

  delete(id: string): boolean {
    return this.db.delete(apiSessions).where(eq(apiSessions.id, id)).returning().all().length > 0;
  }
}
