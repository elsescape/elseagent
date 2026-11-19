import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStateDb } from "./db.ts";
import { MemoryStore } from "./memory.ts";
import { EMBEDDED_MIGRATIONS } from "./migrate.ts";
import { MessageQueue, type NewQueuedMessage } from "./queue.ts";
import { SessionStore } from "./sessions.ts";
import { TodoStore } from "./todos.ts";

const DAY = 24 * 60 * 60 * 1000;

test("agent memory and todos survive reopening its database", () => {
  const dir = mkdtempSync(join(tmpdir(), "elseagent-memory-"));
  try {
    const path = join(dir, "agent.sqlite");
    const source = { user: "U1", channel: "C1", conversationKey: "C1:1.0" };
    {
      const db = openStateDb(path);
      using _client = db.$client;
      new MemoryStore(db).upsert("release.language", "Chinese", undefined, source);
      new TodoStore(db).create("Verify image tags", "", source);
    }
    const reopened = openStateDb(path);
    using _client = reopened.$client;
    expect(new MemoryStore(reopened).get("release.language")).toMatchObject({ content: "Chinese" });
    expect(new TodoStore(reopened).list("active", 10)).toMatchObject([
      { title: "Verify image tags" },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("migrations", () => {
  test("preserves old cron tasks and deleted schedule IDs when adding one-time tasks", () => {
    using db = new Database(":memory:", { strict: true });
    for (const migration of EMBEDDED_MIGRATIONS.slice(0, 6)) {
      for (const sql of migration.sql) db.exec(sql);
    }
    db.exec(`
      INSERT INTO schedules (id, name, cron, timezone, channel, prompt, created_by, created_at,
        next_run_at, last_run_at)
      VALUES (2, 'Daily', '0 9 * * *', 'UTC', 'C1', 'Check CI', 'U1', 1, 3, 2),
        (10, 'Deleted', '0 9 * * *', 'UTC', 'C1', 'Check CI', 'U1', 1, 3, NULL);
      DELETE FROM schedules WHERE id = 10;
    `);
    for (const sql of EMBEDDED_MIGRATIONS[6]?.sql ?? []) db.exec(sql);
    expect(
      db.query("SELECT id, cron, next_run_at, last_run_at, last_skipped_at FROM schedules").all(),
    ).toEqual([
      { id: 2, cron: "0 9 * * *", next_run_at: 3, last_run_at: 2, last_skipped_at: null },
    ]);
    expect(db.query("SELECT seq FROM sqlite_sequence WHERE name = 'schedules'").get()).toEqual({
      seq: 10,
    });
  });

  test("every migration in drizzle/ is embedded", async () => {
    const journal = (await Bun.file(
      join(import.meta.dir, "../../drizzle/meta/_journal.json"),
    ).json()) as {
      entries: unknown[];
    };
    expect(EMBEDDED_MIGRATIONS).toHaveLength(journal.entries.length);
  });

  test("build the current schema and are applied only once", () => {
    const path = join(import.meta.dir, `.test-${crypto.randomUUID()}.sqlite`);
    try {
      openStateDb(path).$client.close();
      const db = openStateDb(path); // reopen: nothing to apply
      const columns = (table: string) =>
        db.$client
          .query(`SELECT name FROM pragma_table_info('${table}')`)
          .all()
          .map((r) => (r as { name: string }).name);
      expect(columns("sessions")).toEqual([
        "conversation_key",
        "thread_id",
        "last_active_at",
        "last_seen_ts",
        "muted",
        "last_addressed_at",
        "unanswered",
        "replied_to",
      ]);
      expect(columns("queue")).toContain("mode");
      expect(db.$client.query("SELECT COUNT(*) AS n FROM __drizzle_migrations").get()).toEqual({
        n: EMBEDDED_MIGRATIONS.length,
      });
      db.$client.close();
    } finally {
      for (const suffix of ["", "-wal", "-shm"])
        Bun.file(path + suffix)
          .delete()
          .catch(() => {});
    }
  });
});

describe("SessionStore", () => {
  test("maps a conversation to its Codex thread and expires idle ones", () => {
    let now = 1_000 * DAY;
    const store = new SessionStore(openStateDb(":memory:"), () => now);
    expect(store.get("C1:1.0", 7 * DAY)).toBeNull();

    store.touch("C1:1.0", "thread-a");
    expect(store.get("C1:1.0", 7 * DAY)?.threadId).toBe("thread-a");

    now += 6 * DAY;
    store.touch("C1:1.0", "thread-a"); // activity resets the idle clock
    now += 6 * DAY;
    expect(store.get("C1:1.0", 7 * DAY)?.threadId).toBe("thread-a");

    now += 2 * DAY; // 8 days idle
    expect(store.get("C1:1.0", 7 * DAY)).toBeNull();
    expect(store.expire(7 * DAY)).toBe(1);
    expect(store.expire(7 * DAY)).toBe(0);
  });

  test("remembers the last Slack message Codex saw", () => {
    const store = new SessionStore(openStateDb(":memory:"));
    store.touch("C1:1.0", "t", "5.0");
    expect(store.get("C1:1.0", DAY)).toEqual({ threadId: "t", lastSeenTs: "5.0" });
    store.touch("C1:1.0", "t", "9.0");
    expect(store.get("C1:1.0", DAY)?.lastSeenTs).toBe("9.0");
  });

  test("reset (/new) clears the thread but keeps the conversation out of the session list", () => {
    const store = new SessionStore(openStateDb(":memory:"));
    store.touch("D1", "thread-a", "1.0");
    store.reset("D1", null);
    expect(store.get("D1", DAY)).toEqual({ threadId: null, lastSeenTs: null });
    expect(store.list()).toEqual([]);
    expect(store.count()).toBe(0);
    store.touch("D1", "thread-b", "2.0");
    expect(store.get("D1", DAY)?.threadId).toBe("thread-b");
  });

  test("re-points a conversation to a new thread", () => {
    const store = new SessionStore(openStateDb(":memory:"));
    store.touch("D1", "old");
    store.touch("D1", "new");
    expect(store.get("D1", DAY)?.threadId).toBe("new");
  });
});

describe("MessageQueue", () => {
  const msg = (conversationKey: string, text: string): NewQueuedMessage => ({
    conversationKey,
    channel: "C1",
    ts: "1.0",
    threadTs: null,
    user: "U1",
    text,
  });

  test("is FIFO and reports positions", () => {
    const q = new MessageQueue(openStateDb(":memory:"));
    const a = q.push(msg("A", "a"));
    const b = q.push(msg("B", "b"));
    expect(q.pendingCount()).toBe(2);
    expect(q.position(b.id)).toBe(2);
    expect(q.claimNext()?.id).toBe(a.id);
    expect(q.position(b.id)).toBe(1);
    expect(q.claimNext()?.id).toBe(b.id);
    expect(q.claimNext()).toBeNull();
  });

  test("never runs two messages of the same conversation at once", () => {
    const q = new MessageQueue(openStateDb(":memory:"));
    const a1 = q.push(msg("A", "a1"));
    const a2 = q.push(msg("A", "a2"));
    const b1 = q.push(msg("B", "b1"));

    expect(q.claimNext()?.id).toBe(a1.id);
    expect(q.claimNext()?.id).toBe(b1.id); // a2 skipped: A is busy
    expect(q.claimNext()).toBeNull();

    q.remove(a1.id);
    expect(q.claimNext()?.id).toBe(a2.id);
  });

  test("removed messages are gone; nothing is kept as history", () => {
    const db = openStateDb(":memory:");
    const q = new MessageQueue(db);
    q.remove(q.push(msg("A", "a")).id);
    expect(db.$client.query("SELECT COUNT(*) AS n FROM queue").get()).toEqual({ n: 0 });
  });

  test("survives a restart; messages left running are handed back as interrupted", () => {
    const path = join(import.meta.dir, `.test-${crypto.randomUUID()}.sqlite`);
    try {
      const q1 = new MessageQueue(openStateDb(path));
      const running = q1.push(msg("A", "was running"));
      const waiting = q1.push(msg("B", "still waiting"));
      q1.claimNext();

      const q2 = new MessageQueue(openStateDb(path));
      expect(q2.takeInterrupted().map((m) => m.id)).toEqual([running.id]);
      expect(q2.pendingCount()).toBe(1);
      expect(q2.claimNext()).toMatchObject({ id: waiting.id, text: "still waiting" });
    } finally {
      for (const suffix of ["", "-wal", "-shm"])
        Bun.file(path + suffix)
          .delete()
          .catch(() => {});
    }
  });

  test("hasNewerPending: a later message of the same conversation is waiting", () => {
    const queue = new MessageQueue(openStateDb(":memory:"));
    const base = { channel: "C1", ts: "1.0", threadTs: null, user: "U1", text: "x" };
    const a = queue.push({ ...base, conversationKey: "A" });
    queue.push({ ...base, conversationKey: "B" });
    expect(queue.hasNewerPending("A", a.id)).toBe(false);
    queue.push({ ...base, conversationKey: "A", mode: "passive" });
    expect(queue.hasNewerPending("A", a.id)).toBe(true);
  });
});
