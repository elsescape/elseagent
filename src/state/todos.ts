import { and, desc, eq, inArray } from "drizzle-orm";
import type { StateDb } from "./db.ts";
import type { RecordSource } from "./memory.ts";
import { TODO_STATUSES, todos } from "./schema.ts";

export type TodoStatus = (typeof TODO_STATUSES)[number];
/** What a list of todos can be narrowed to: one status, the ones still open, or everything. */
export const TODO_FILTERS = ["active", "all", ...TODO_STATUSES] as const;
export type TodoFilter = (typeof TODO_FILTERS)[number];
type TodoUpdate = { title?: string; details?: string; status?: TodoStatus };

export { TODO_STATUSES };

export class TodoStore {
  constructor(private readonly db: StateDb) {}

  list(status: TodoFilter, limit: number) {
    const filter =
      status === "all"
        ? undefined
        : status === "active"
          ? inArray(todos.status, ["pending", "in_progress"])
          : eq(todos.status, status);
    return this.db
      .select()
      .from(todos)
      .where(filter)
      .orderBy(desc(todos.updatedAt), desc(todos.id))
      .limit(limit)
      .all();
  }

  create(title: string, details: string, source: RecordSource) {
    const now = Date.now();
    return this.db
      .insert(todos)
      .values({
        title,
        details,
        version: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
        updatedBy: source.user,
        sourceChannel: source.channel,
        sourceConversation: source.conversationKey,
      })
      .returning()
      .get();
  }

  update(id: number, version: string, patch: TodoUpdate, source: RecordSource) {
    return this.db
      .update(todos)
      .set({
        ...patch,
        version: crypto.randomUUID(),
        updatedAt: Date.now(),
        updatedBy: source.user,
        sourceChannel: source.channel,
        sourceConversation: source.conversationKey,
      })
      .where(and(eq(todos.id, id), eq(todos.version, version)))
      .returning()
      .get();
  }
}
