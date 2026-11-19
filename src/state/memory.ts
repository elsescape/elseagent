import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import type { StateDb } from "./db.ts";
import { memories } from "./schema.ts";

export interface RecordSource {
  user: string;
  channel: string;
  conversationKey: string;
}

export class MemoryStore {
  constructor(private readonly db: StateDb) {}

  get(key: string) {
    return this.db.select().from(memories).where(eq(memories.key, key)).get();
  }

  search(query: string | undefined, limit: number) {
    const needle = query?.toLowerCase();
    return this.db
      .select()
      .from(memories)
      .where(
        needle
          ? or(
              sql`instr(lower(${memories.key}), ${needle}) > 0`,
              sql`instr(lower(${memories.content}), ${needle}) > 0`,
            )
          : undefined,
      )
      .orderBy(desc(memories.updatedAt), asc(memories.key))
      .limit(limit)
      .all();
  }

  /** Insert a new key or replace the exact version the caller read. */
  upsert(key: string, content: string, version: string | undefined, source: RecordSource) {
    const update = {
      content,
      version: crypto.randomUUID(),
      updatedAt: Date.now(),
      updatedBy: source.user,
      sourceChannel: source.channel,
      sourceConversation: source.conversationKey,
    };
    if (version === undefined) {
      return this.db
        .insert(memories)
        .values({ key, createdAt: update.updatedAt, ...update })
        .onConflictDoNothing()
        .returning()
        .get();
    }
    return this.db
      .update(memories)
      .set(update)
      .where(and(eq(memories.key, key), eq(memories.version, version)))
      .returning()
      .get();
  }

  delete(key: string, version: string) {
    return this.db
      .delete(memories)
      .where(and(eq(memories.key, key), eq(memories.version, version)))
      .returning({ key: memories.key })
      .get();
  }
}
