/**
 * Cloudflare Worker entry. Bindings only exist inside `fetch`, so the context
 * is built per request; Hyperdrive keeps the real connection pool warm on the
 * edge, which is what makes a fresh postgres client per request affordable.
 *
 * Storage is R2 spoken as S3 (the existing adapter): the R2 binding cannot mint
 * the signed upload URLs the CLI needs, so STORAGE_ACCESS_KEY / STORAGE_SECRET_KEY
 * for an R2 API token are required even when the bucket is also bound.
 */

import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { createEmailSender } from "../services/email.js";
import { createStorage } from "../storage/index.js";

export interface WorkerEnv {
  HYPERDRIVE: { connectionString: string };
  [binding: string]: unknown;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const config = loadConfig({
      ...(env as Record<string, string | undefined>),
      DATABASE_URL: env.HYPERDRIVE.connectionString,
    });

    const { db, close } = createDb(config.DATABASE_URL, { max: 1 });

    const response = await createApp({
      db,
      storage: await createStorage(config),
      config,
      email: createEmailSender(config),
      now: () => new Date(),
    }).fetch(request);

    // Every route buffers its response before returning, so the connection has
    // no reader left by this point.
    ctx.waitUntil(close());
    return response;
  },
};
