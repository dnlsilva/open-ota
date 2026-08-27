/**
 * Device API — the only routes apps in the field call. Authenticated by the
 * project's public app key, which identifies but never authorises: what
 * protects the payload is the signature over the manifest, not a secret held
 * on the device.
 */

import {
  APP_KEY_HEADER,
  eventsRequestSchema,
  updateCheckQuerySchema,
  verifyPreviewToken,
} from "@open-ota/shared";
import { Hono } from "hono";
import type { AppEnv } from "../app.js";
import { ApiError } from "../services/errors.js";
import { findProjectByAppKey } from "../services/projects.js";
import { getRelease, resolveUpdate, signManifest, toManifest } from "../services/releases.js";
import { recordEvents, touchDevice } from "../services/telemetry.js";
import { eq } from "drizzle-orm";
import { channels } from "../db/schema.js";

export function deviceRoutes() {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const appKey = c.req.header(APP_KEY_HEADER);
    if (!appKey) throw ApiError.unauthorized(`Missing ${APP_KEY_HEADER} header`);
    c.set("project", await findProjectByAppKey(c.get("ctx"), appKey));
    await next();
  });

  app.get("/update-check", async (c) => {
    const ctx = c.get("ctx");
    const project = c.get("project");

    const parsed = updateCheckQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      throw ApiError.badRequest("invalid_query", "Malformed update-check parameters", parsed.error.flatten());
    }
    const query = parsed.data;

    const response = await resolveUpdate(ctx, project, query);

    // This request is the heartbeat: recording it here is what makes active
    // users per version free, with no separate analytics call.
    await touchDevice(ctx, {
      deviceId: query.device,
      projectId: project.id,
      platform: query.platform,
      channel: query.channel,
      nativeVersion: query.native,
      runtimeVersion: query.runtime,
      currentReleaseId: query.current ?? null,
    });

    // Bundles are immutable but the decision is per device, so never cache it.
    c.header("cache-control", "no-store");
    return c.json(response);
  });

  app.post("/events", async (c) => {
    const ctx = c.get("ctx");
    const project = c.get("project");

    const parsed = eventsRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw ApiError.badRequest("invalid_events", "Malformed event batch", parsed.error.flatten());
    }

    await recordEvents(ctx, project.id, parsed.data);
    return c.body(null, 202);
  });

  /**
   * Preview: the token is re-validated here, not just on the device, so a
   * short expiry doubles as revocation.
   */
  app.get("/preview/manifest", async (c) => {
    const ctx = c.get("ctx");
    const project = c.get("project");
    const d = c.req.query("d");
    const s = c.req.query("s");
    if (!d || !s) throw ApiError.badRequest("missing_token", "Preview links need both d and s");

    const result = await verifyPreviewToken(d, s, project.publicKey, {
      expectedProjectId: project.id,
      clockSkewSeconds: 0,
    });
    if (!result.ok) {
      throw ApiError.badRequest("invalid_preview_token", previewFailureMessage(result.reason));
    }

    const release = await getRelease(ctx, result.payload.releaseId);
    if (release.projectId !== project.id) {
      throw ApiError.notFound("release_not_found", "No release with that id");
    }
    if (release.status === "pending") {
      throw ApiError.conflict("release_not_confirmed", "That release has no confirmed bundle yet");
    }

    const channel = await ctx.db.query.channels.findFirst({ where: eq(channels.id, release.channelId) });
    const manifest = toManifest(release, project.id, channel?.name ?? "");
    const signature = release.signature ?? (await signManifest(ctx, project, manifest));

    c.header("cache-control", "no-store");
    return c.json({
      action: "update" as const,
      mandatory: false,
      manifest,
      signature,
      url: ctx.storage.publicUrl(release.storageKey),
    });
  });

  return app;
}

function previewFailureMessage(reason: string): string {
  switch (reason) {
    case "expired":
      return "This preview link has expired — generate a new one from the dashboard";
    case "wrongProject":
      return "This preview link belongs to a different project";
    case "badSignature":
      return "This preview link was not issued by this server";
    default:
      return "This preview link is malformed";
  }
}
