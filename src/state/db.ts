import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import { runMigrations } from "./migrate.ts";
import * as schema from "./schema.ts";

export type StateDb = BunSQLiteDatabase<typeof schema> & { $client: Database };

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
