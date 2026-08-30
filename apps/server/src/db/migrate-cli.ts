/**
 * `pnpm db:migrate` — for the targets whose entry does not migrate on boot
 * (Supabase, Cloudflare) and for CI. Kept out of migrate.ts because the Node
 * entry bundles that module, and a top-level script would run on every boot.
 */

import { createDb } from "./client.js";
import { runMigrations } from "./migrate.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const handle = createDb(url, { max: 1 });
await runMigrations(handle.db);
await handle.close();
console.info("migrations applied");
