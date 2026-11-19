import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { count, type SQL } from "drizzle-orm";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { runMigrations } from "./migrate.ts";
import * as schema from "./schema.ts";

export type StateDb = BunSQLiteDatabase<typeof schema> & { $client: Database };

/** How many rows of `table` match `where`. */
export function countWhere(db: StateDb, table: SQLiteTable, where: SQL | undefined): number {
  return db.select({ n: count() }).from(table).where(where).get()?.n ?? 0;
}

/** Open (creating if needed) the state database and bring its schema up to date. */
export function openStateDb(path: string): StateDb {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const client = new Database(path, { create: true, strict: true });
  try {
    client.exec("PRAGMA journal_mode = WAL");
    client.exec("PRAGMA busy_timeout = 5000");
    const db = drizzle({ client, schema });
    runMigrations(db);
    return db;
  } catch (err) {
    client.close();
    throw err;
  }
}
