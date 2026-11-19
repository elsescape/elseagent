import { and, asc, count, eq, isNotNull, lte } from "drizzle-orm";
import type { StateDb } from "./db.ts";
import { schedules } from "./schema.ts";

export type Schedule = typeof schedules.$inferSelect;
export type NewSchedule = Omit<
  typeof schedules.$inferInsert,
  "id" | "createdAt" | "lastRunAt" | "lastSkippedAt"
>;

/** Scheduled tasks. Computing run times (cron) is the caller's job; this only stores them. */
export class ScheduleStore {
  constructor(
    private readonly db: StateDb,
    private readonly now: () => number = Date.now,
  ) {}

  create(schedule: NewSchedule): Schedule {
    return this.db
      .insert(schedules)
      .values({ ...schedule, createdAt: this.now() })
      .returning()
      .get();
  }

  get(id: number): Schedule | null {
    return this.db.select().from(schedules).where(eq(schedules.id, id)).get() ?? null;
  }

  list(): Schedule[] {
    return this.db.select().from(schedules).orderBy(asc(schedules.id)).all();
  }

  count(): number {
    return (
      this.db.select({ n: count() }).from(schedules).where(isNotNull(schedules.nextRunAt)).get()
        ?.n ?? 0
    );
  }

  delete(id: number): Schedule | null {
    return this.db.delete(schedules).where(eq(schedules.id, id)).returning().get() ?? null;
  }

  /** Schedules whose next run time has come. */
  due(): Schedule[] {
    return this.db
      .select()
      .from(schedules)
      .where(lte(schedules.nextRunAt, this.now()))
      .orderBy(asc(schedules.nextRunAt))
      .all();
  }

  /** Advance this occurrence and enqueue it in the same SQLite transaction. */
  advanceDue(id: number, dueAt: number, nextRunAt: number | null, enqueue: () => boolean) {
    return this.db.transaction(() => {
      const updated = this.db
        .update(schedules)
        .set({ nextRunAt })
        .where(and(eq(schedules.id, id), eq(schedules.nextRunAt, dueAt)))
        .returning({ id: schedules.id })
        .get();
      if (!updated) return "stale";
      const queued = enqueue();
      this.db
        .update(schedules)
        .set(queued ? { lastRunAt: this.now() } : { lastSkippedAt: dueAt })
        .where(eq(schedules.id, id))
        .run();
      return queued ? "queued" : "skipped";
    });
  }
}
