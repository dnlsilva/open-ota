/**
 * Node entry — the self-hosted target (docker compose) and the hosted SaaS.
 *
 * Boots the whole install by itself: migrations, plans, and on a fresh database
 * the first admin, so `docker compose up` needs no second command.
 */

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { sql } from "drizzle-orm";
import type { Context } from "hono";
import { join, resolve } from "node:path";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { users } from "../db/schema.js";
import { signup } from "../services/auth.js";
import type { AppContext } from "../services/context.js";
import { createEmailSender } from "../services/email.js";
import { seedPlans } from "../services/orgs.js";
import { createStorage } from "../storage/index.js";

const SHUTDOWN_GRACE_MS = 10_000;
/** Paths the API owns; everything else is the dashboard's client-side router. */
const SERVER_PREFIXES = ["/api", "/oauth", "/mcp", "/healthz", "/.well-known"];

const config = loadConfig(process.env);
const { db, close } = createDb(config.DATABASE_URL);

// ponytail: no advisory lock. Two replicas booting at the same instant can race
// here; add `pg_advisory_lock` around it when the deploy is more than one pod.
await runMigrations(db);

const ctx: AppContext = {
  db,
  storage: await createStorage(config),
  config,
  email: createEmailSender(config),
  now: () => new Date(),
};

await seedPlans(ctx);
await bootstrapAdmin(ctx);

const app = createApp(ctx);
if (config.DASHBOARD_DIR) serveDashboard(app, config.DASHBOARD_DIR);

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.info(`[boot] open-ota listening on :${info.port} (mode=${config.mode}, storage=${ctx.storage.name})`);
});

let closing = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    console.info(`[boot] ${signal} received, draining`);
    setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
    server.close(() => {
      void close().then(() => process.exit(0));
    });
  });
}

/**
 * Self-hosted convenience: on a database with no users, OTA_ADMIN_EMAIL and
 * OTA_ADMIN_PASSWORD create the single admin and its org. Hosted installs sign
 * up through the dashboard, so this is skipped there.
 */
async function bootstrapAdmin(context: AppContext): Promise<void> {
  const email = process.env.OTA_ADMIN_EMAIL;
  const password = process.env.OTA_ADMIN_PASSWORD;
  if (context.config.hosted || !email || !password) return;

  const [row] = await context.db.select({ count: sql<number>`count(*)::int` }).from(users);
  if ((row?.count ?? 0) > 0) return;

  try {
    await signup(context, { email, password });
    console.info(`[boot] created the first admin account: ${email}`);
  } catch (error) {
    // Keep serving: the dashboard can still register the first account. Staying
    // quiet here would leave an operator locked out with no reason given.
    console.error(`[boot] OTA_ADMIN_EMAIL was set but the account was not created: ${message(error)}`);
  }
}

function serveDashboard(target: ReturnType<typeof createApp>, dir: string): void {
  const root = resolve(dir);
  const files = serveStatic({ root });
  const index = serveStatic({ path: join(root, "index.html") });

  target.use("*", async (c, next) => (isServerRoute(c) ? next() : files(c, next)));
  // Fallback: /projects/<id> is a route in the SPA, not a file on disk.
  target.use("*", async (c, next) => (isServerRoute(c) ? next() : index(c, next)));
}

function isServerRoute(c: Context): boolean {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return true;
  return SERVER_PREFIXES.some((prefix) => c.req.path.startsWith(prefix));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
