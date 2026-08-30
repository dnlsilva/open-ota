/**
 * Supabase Edge Function entry (`supabase functions deploy ota`).
 *
 * The constraint that shaped the publish flow lives here: an edge function
 * cannot stream a 50–200 MB bundle body, so the CLI PUTs the zip straight to
 * Supabase Storage with a signed URL and only the manifest passes through this
 * process (ARCHITECTURE §2 "Upload"). Migrations and plan seeding are not run
 * on boot either — `supabase db push` owns the schema on this target.
 */

import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { createEmailSender } from "../services/email.js";
import { createStorage } from "../storage/index.js";

declare const Deno: {
  env: { toObject(): Record<string, string> };
  serve(handler: (request: Request) => Response | Promise<Response>): unknown;
};

const config = loadConfig(Deno.env.toObject());
// One request per isolate, so a pool of one is the whole pool.
const { db } = createDb(config.DATABASE_URL, { max: 1 });

const app = createApp({
  db,
  storage: await createStorage(config),
  config,
  email: createEmailSender(config),
  now: () => new Date(),
});

Deno.serve(app.fetch);
