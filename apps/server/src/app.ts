/**
 * Hono app assembly. The same object is served by the Node entry, the Supabase
 * Edge Function and the Cloudflare Worker — only the adapter around it changes.
 *
 * Device routes and admin routes are separate routers from day one: they have
 * very different traffic shapes, so splitting them into two deployments later
 * is a mechanical change rather than a refactor.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { ZodError } from "zod";
import { corsOrigins, type AppConfig } from "./config.js";
import { plans, type ProjectRow } from "./db/schema.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { billingRoutes } from "./routes/billing.js";
import { deviceRoutes } from "./routes/device.js";
import { mcpRoutes } from "./routes/mcp.js";
import { oauthRoutes } from "./routes/oauth.js";
import { storageRoutes } from "./routes/storage.js";
import { authenticate } from "./services/auth.js";
import type { Actor, AppContext } from "./services/context.js";
import { ApiError } from "./services/errors.js";

export interface AppEnv {
  Variables: {
    ctx: AppContext;
    actor: Actor;
    project: ProjectRow;
  };
}

export function createApp(ctx: AppContext) {
  const app = new Hono<AppEnv>();
  const config: AppConfig = ctx.config;

  app.use("*", async (c, next) => {
    c.set("ctx", ctx);
    await next();
  });

  app.use(
    "/api/*",
    cors({
      origin: corsOrigins(config) === "*" ? "*" : (corsOrigins(config) as string[]),
      allowHeaders: ["authorization", "content-type", "x-ota-app-key", "x-ota-sdk-version"],
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      maxAge: 86_400,
    }),
  );

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as 400);
    }
    if (err instanceof ZodError) {
      return c.json(
        { error: { code: "invalid_request", message: "Request body failed validation", details: err.flatten() } },
        400,
      );
    }
    console.error("[unhandled]", err);
    return c.json({ error: { code: "internal_error", message: "Something went wrong on our side" } }, 500);
  });

  app.get("/healthz", (c) =>
    c.json({ ok: true, mode: config.mode, storage: ctx.storage.name, billing: config.billingEnabled }),
  );

  /** Lets the dashboard adapt (hide signup and billing on a self-hosted install). */
  const meta = {
    mode: config.mode,
    hosted: config.hosted,
    billingEnabled: config.billingEnabled,
    signupEnabled: config.hosted,
    version: "0.1.0",
  };
  app.get("/api/v1/meta", (c) => c.json(meta));
  // The dashboard asks for this before it has a token; keep both names working
  // so a client built against either one keeps running after an upgrade.
  app.get("/api/v1/config", (c) => c.json(meta));

  /** Plan catalogue for the billing screen. Public: prices are not a secret. */
  app.get("/api/v1/plans", async (c) => {
    const rows = await ctx.db.select().from(plans).orderBy(plans.priceMonthCents);
    return c.json({
      plans: rows.map((p) => ({
        id: p.id,
        name: p.name,
        maxProjects: p.maxProjects,
        maxActiveDevices: p.maxActiveDevices,
        maxStorageGb: p.maxStorageGb,
        priceMonthCents: p.priceMonthCents,
      })),
    });
  });

  app.route("/api/v1/auth", authRoutes());
  app.route("/api/v1", deviceRoutes());
  app.route("/api/v1/storage", storageRoutes());

  // Everything past this point needs a Bearer token.
  app.use("/api/v1/*", async (c, next) => {
    if (isPublicPath(c.req.path)) return next();
    c.set("actor", await authenticate(ctx, c.req.header("authorization")));
    await next();
  });

  app.route("/api/v1", adminRoutes());
  app.route("/api/v1/billing", billingRoutes());
  app.route("/oauth", oauthRoutes());
  app.route("/mcp", mcpRoutes());

  app.get("/.well-known/oauth-protected-resource", (c) =>
    c.json({
      resource: `${config.publicUrl}/mcp`,
      authorization_servers: [config.publicUrl],
      scopes_supported: ["admin", "read"],
      bearer_methods_supported: ["header"],
    }),
  );

  app.get("/.well-known/oauth-authorization-server", (c) =>
    c.json({
      issuer: config.publicUrl,
      authorization_endpoint: `${config.publicUrl}/oauth/authorize`,
      token_endpoint: `${config.publicUrl}/oauth/token`,
      registration_endpoint: `${config.publicUrl}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["admin", "read"],
    }),
  );

  return app;
}

const PUBLIC_PATHS = [
  "/api/v1/meta",
  "/api/v1/auth/",
  "/api/v1/update-check",
  "/api/v1/events",
  "/api/v1/preview/manifest",
  "/api/v1/storage/",
  "/api/v1/billing/webhook",
  "/api/v1/config",
  "/api/v1/plans",
];

function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p));
}
