import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { schema } from "./schema.js";

export type Db = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  close: () => Promise<void>;
}

export function createDb(databaseUrl: string, opts: { max?: number } = {}): DbHandle {
  // Edge runtimes run one request per isolate, so a small pool is right there;
  // the Node server gets a normal one.
  const sql = postgres(databaseUrl, { max: opts.max ?? 10, prepare: false });
  return {
    db: drizzle(sql, { schema }),
    close: () => sql.end({ timeout: 5 }),
  };
}
