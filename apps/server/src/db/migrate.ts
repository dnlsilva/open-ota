/**
 * Applies pending migrations. Imported by the Node entry so `docker compose up`
 * against an empty volume just works, and by migrate-cli.ts for `pnpm db:migrate`.
 */

import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Db } from "./client.js";

/**
 * Resolved from this module rather than from cwd, so it holds when the entry is
 * run from src/ (tsx), from dist/entry/node.js (bundle) and from a container.
 */
export const MIGRATIONS_DIR = new URL("../../drizzle", import.meta.url).pathname;

export function runMigrations(db: Db): Promise<void> {
  return migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}
