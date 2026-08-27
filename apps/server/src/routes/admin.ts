/**
 * Admin API — the single surface behind the dashboard, the CLI and the MCP
 * server. Anything added here is available to all three at once.
 */

import {
  createPreviewToken,
  decryptSecret,
  PREVIEW_DEFAULT_TTL_MINUTES,
  previewDeepLink,
  type Platform,
} from "@open-ota/shared";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.js";
import { apiTokens, channels, orgs, projects, releases } from "../db/schema.js";
import { authorizeProject, issueToken, requireAdminScope, requireOrgRole } from "../services/auth.js";
import { ApiError } from "../services/errors.js";
import {
  DEFAULT_WINDOW_DAYS,
  getDistribution,
  getProjectOverview,
  getReleaseMetrics,
  listRollbacks,
  toReleaseDto,
} from "../services/metrics.js";
import { getSubscription, getUsage } from "../services/orgs.js";
import { createProject, toProjectDto } from "../services/projects.js";
import {
  confirmRelease,
  ensureChannel,
  findRelease,
  getRelease,
  promoteRelease,
  prepareUpload,
  requireProject,
  rollbackRelease,
  updateRelease,
} from "../services/releases.js";
import { assertCanPublish } from "../services/orgs.js";
import { uuidv7 } from "@open-ota/shared";

const platformSchema = z.enum(["ios", "android"]);

export function adminRoutes() {
  const app = new Hono<AppEnv>();

  /* ------------------------------------------------------------------ orgs */

  app.get("/orgs", async (c) => {
    const ctx = c.get("ctx");
    const actor = c.get("actor");
    const rows = await ctx.db.select().from(orgs).where(eq(orgs.id, actor.orgId));
    return c.json({
      orgs: rows.map((o) => ({
        id: o.id,
        name: o.name,
        slug: o.slug,
        planId: o.planId,
        trialEndsAt: o.trialEndsAt?.toISOString() ?? null,
        createdAt: o.createdAt.toISOString(),
      })),
    });
  });

  app.get("/orgs/:orgId/usage", async (c) => {
    const ctx = c.get("ctx");
    const actor = c.get("actor");
    const orgId = c.req.param("orgId");
    if (orgId !== actor.orgId) throw ApiError.forbidden();
    return c.json({ usage: await getUsage(ctx, orgId), subscription: await getSubscription(ctx, orgId) });
  });

  /* -------------------------------------------------------------- projects */

  app.get("/projects", async (c) => {
    const ctx = c.get("ctx");
    const actor = c.get("actor");
    const rows = await ctx.db
      .select()
      .from(projects)
      .where(eq(projects.orgId, actor.orgId))
      .orderBy(desc(projects.createdAt));

    const visible = actor.projectId ? rows.filter((r) => r.id === actor.projectId) : rows;
    return c.json({ projects: visible.map(toProjectDto) });
  });

  app.post("/projects", async (c) => {
    const ctx = c.get("ctx");
    const actor = c.get("actor");
    requireAdminScope(actor);

    const body = z
      .object({ name: z.string().min(1).max(80), deepLinkScheme: z.string().max(40).optional() })
      .parse(await c.req.json());

    const project = await createProject(ctx, { orgId: actor.orgId, ...body });
    return c.json({ project }, 201);
  });

  app.get("/projects/:projectId", async (c) => {
    const project = await authorizeProject(c.get("ctx"), c.get("actor"), c.req.param("projectId"));
    return c.json({ project: toProjectDto(project) });
  });

  app.get("/projects/:projectId/public-key", async (c) => {
    const project = await authorizeProject(c.get("ctx"), c.get("actor"), c.req.param("projectId"));
    return c.json({ publicKey: project.publicKey, appKey: project.appKey });
  });

  app.get("/projects/:projectId/overview", async (c) => {
    const ctx = c.get("ctx");
    await authorizeProject(ctx, c.get("actor"), c.req.param("projectId"));
    return c.json(await getProjectOverview(ctx, c.req.param("projectId")));
  });

  /* -------------------------------------------------------------- channels */

  app.get("/projects/:projectId/channels", async (c) => {
    const ctx = c.get("ctx");
    const project = await authorizeProject(ctx, c.get("actor"), c.req.param("projectId"));
    const rows = await ctx.db
      .select()
      .from(channels)
      .where(eq(channels.projectId, project.id))
      .orderBy(channels.name);
    return c.json({
      channels: rows.map((ch) => ({
        id: ch.id,
        projectId: ch.projectId,
        name: ch.name,
        createdAt: ch.createdAt.toISOString(),
      })),
    });
  });

  app.post("/projects/:projectId/channels", async (c) => {
    const ctx = c.get("ctx");
    const actor = c.get("actor");
    requireAdminScope(actor);
    const project = await authorizeProject(ctx, actor, c.req.param("projectId"));
    const { name } = z.object({ name: z.string().min(1).max(64) }).parse(await c.req.json());
    const channel = await ensureChannel(ctx, project.id, name);
    return c.json({
      channel: {
        id: channel.id,
        projectId: channel.projectId,
        name: channel.name,
        createdAt: channel.createdAt.toISOString(),
      },
    });
  });

  /* -------------------------------------------------------------- releases */

  app.get("/projects/:projectId/releases", async (c) => {
    const ctx = c.get("ctx");
    const project = await authorizeProject(ctx, c.get("actor"), c.req.param("projectId"));
    const query = z
      .object({
        channel: z.string().optional(),
        platform: platformSchema.optional(),
        status: z.enum(["pending", "active", "paused", "disabled"]).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(c.req.query());

    const conditions = [eq(releases.projectId, project.id)];
    if (query.platform) conditions.push(eq(releases.platform, query.platform));
    if (query.status) conditions.push(eq(releases.status, query.status));
    if (query.channel) {
      const channel = await ctx.db.query.channels.findFirst({
        where: and(eq(channels.projectId, project.id), eq(channels.name, query.channel)),
      });
      if (!channel) return c.json({ releases: [] });
      conditions.push(eq(releases.channelId, channel.id));
    }

    const rows = await ctx.db
      .select({ release: releases, channelName: channels.name })
      .from(releases)
      .innerJoin(channels, eq(channels.id, releases.channelId))
      .where(and(...conditions))
      .orderBy(desc(releases.id))
      .limit(query.limit);

    return c.json({ releases: rows.map((r) => toReleaseDto(r.release, r.channelName)) });
  });

  app.post("/projects/:projectId/releases/prepare-upload", async (c) => {
    const ctx = c.get("ctx");
    const actor = c.get("actor");
    requireAdminScope(actor);
    const project = await authorizeProject(ctx, actor, c.req.param("projectId"));

    const body = z
      .object({
        sha256: z.string(),
        size: z.number().int().positive(),
        platform: platformSchema,
        channel: z.string().min(1).max(64),
        runtimeVersion: z.string().min(1).max(128),
        rolloutPercent: z.number().min(0).max(100).optional(),
        mandatory: z.boolean().optional(),
        message: z.string().max(500).optional(),
        gitCommit: z.string().max(80).optional(),
        groupId: z.string().uuid().optional(),
      })
      .parse(await c.req.json());

    await assertCanPublish(ctx, project.orgId, body.size);

    const result = await prepareUpload(ctx, {
      projectId: project.id,
      createdBy: actor.userId,
      ...body,
    });
    return c.json(result, 201);
  });

  app.post("/releases/:releaseId/confirm", async (c) => {
    const ctx = c.get("ctx");
    const actor = c.get("actor");
    requireAdminScope(actor);
    const release = await getRelease(ctx, c.req.param("releaseId"));
    await authorizeProject(ctx, actor, release.projectId);

    const confirmed = await confirmRelease(ctx, release.id);
    const channel = await ctx.db.query.channels.findFirst({ where: eq(channels.id, confirmed.channelId) });
    return c.json({ release: toReleaseDto(confirmed, channel?.name ?? "") });
  });

  app.get("/releases/:releaseId", async (c) => {
    const ctx = c.get("ctx");
    const release = await getRelease(ctx, c.req.param("releaseId"));
    await authorizeProject(ctx, c.get("actor"), release.projectId);
    const channel = await ctx.db.query.channels.findFirst({ where: eq(channels.id, release.channelId) });
    return c.json({ release: toReleaseDto(release, channel?.name ?? "") });
  });

  app.patch("/releases/:releaseId", async (c) => {
    const ctx = c.get("ctx");
    const actor = c.get("actor");
    requireAdminScope(actor);
    const release = await getRelease(ctx, c.req.param("releaseId"));
    await authorizeProject(ctx, actor, release.projectId);

    const patch = z
      .object({
        status: z.enum(["active", "paused", "disabled"]).optional(),
        rolloutPercent: z.number().min(0).max(100).optional(),
        mandatory: z.boolean().optional(),
        message: z.string().max(500).optional(),
      })
      .parse(await c.req.json());

    const updated = await updateRelease(ctx, release.id, patch);
    const channel = await ctx.db.query.channels.findFirst({ where: eq(channels.id, updated.channelId) });
    return c.json({ release: toReleaseDto(updated, channel?.name ?? "") });
  });

  app.post("/releases/:releaseId/promote", async (c) => {
    const ctx = c.get("ctx");
    const actor = c.get("actor");
    requireAdminScope(actor);
    const release = await getRelease(ctx, c.req.param("releaseId"));
    await authorizeProject(ctx, actor, release.projectId);

    const body = z
      .object({ channel: z.string().min(1).max(64), rolloutPercent: z.number().min(0).max(100).optional() })
      .parse(await c.req.json());

    const promoted = await promoteRelease(ctx, release.id, body.channel, body.rolloutPercent);
    return c.json({ release: toReleaseDto(promoted, body.channel) });
  });

  app.post("/releases/:releaseId/rollback", async (c) => {
    const ctx = c.get("ctx");
    const actor = c.get("actor");
    requireAdminScope(actor);
    const release = await getRelease(ctx, c.req.param("releaseId"));
    await authorizeProject(ctx, actor, release.projectId);

    const { release: disabled, target } = await rollbackRelease(ctx, release.id);
    const channel = await ctx.db.query.channels.findFirst({ where: eq(channels.id, disabled.channelId) });
    return c.json({
      release: toReleaseDto(disabled, channel?.name ?? ""),
      target: target ? toReleaseDto(target, channel?.name ?? "") : null,
    });
  });

  app.post("/releases/:releaseId/preview-link", async (c) => {
    const ctx = c.get("ctx");
    const actor = c.get("actor");
    requireAdminScope(actor);
    const release = await getRelease(ctx, c.req.param("releaseId"));
    const project = await authorizeProject(ctx, actor, release.projectId);

    const { ttlMinutes } = z
      .object({ ttlMinutes: z.number().int().min(1).max(1440).optional() })
      .parse(await c.req.json().catch(() => ({})));

    const scheme = project.deepLinkScheme;
    if (!scheme) {
      throw ApiError.badRequest(
        "no_deep_link_scheme",
        "Set a deep link scheme for this project before generating preview links",
      );
    }

    const privateKeyPem = await decryptSecret(project.privateKeyEnc, ctx.config.OTA_MASTER_KEY);
    const ttl = ttlMinutes ?? PREVIEW_DEFAULT_TTL_MINUTES;
    const link = await createPreviewToken(
      { projectId: project.id, releaseId: release.id, ttlMinutes: ttl },
      privateKeyPem,
      ctx.now().getTime(),
    );

    return c.json({
      url: previewDeepLink(scheme, link),
      expiresAt: new Date(link.payload.exp * 1000).toISOString(),
      scheme,
    });
  });

  /* --------------------------------------------------------------- metrics */

  app.get("/releases/:releaseId/metrics", async (c) => {
    const ctx = c.get("ctx");
    const release = await getRelease(ctx, c.req.param("releaseId"));
    await authorizeProject(ctx, c.get("actor"), release.projectId);
    const days = Number(c.req.query("days") ?? 14);
    return c.json(await getReleaseMetrics(ctx, release.id, Number.isFinite(days) ? days : 14));
  });

  app.get("/projects/:projectId/distribution", async (c) => {
    const ctx = c.get("ctx");
    const project = await authorizeProject(ctx, c.get("actor"), c.req.param("projectId"));
    const platform = c.req.query("platform") as Platform | undefined;
    const windowDays = Number(c.req.query("window") ?? DEFAULT_WINDOW_DAYS);
    return c.json(
      await getDistribution(ctx, project.id, {
        platform: platform && ["ios", "android"].includes(platform) ? platform : undefined,
        windowDays: Number.isFinite(windowDays) ? windowDays : DEFAULT_WINDOW_DAYS,
      }),
    );
  });

  app.get("/projects/:projectId/rollbacks", async (c) => {
    const ctx = c.get("ctx");
    const project = await authorizeProject(ctx, c.get("actor"), c.req.param("projectId"));
    const limit = Number(c.req.query("limit") ?? 50);
    return c.json({ rollbacks: await listRollbacks(ctx, project.id, Number.isFinite(limit) ? limit : 50) });
  });

  /* ---------------------------------------------------------------- tokens */

  app.get("/projects/:projectId/tokens", async (c) => {
    const ctx = c.get("ctx");
    const project = await authorizeProject(ctx, c.get("actor"), c.req.param("projectId"));
    const rows = await ctx.db
      .select()
      .from(apiTokens)
      .where(and(eq(apiTokens.orgId, project.orgId), eq(apiTokens.kind, "manual")))
      .orderBy(desc(apiTokens.createdAt));

    return c.json({
      tokens: rows.map((t) => ({
        id: t.id,
        name: t.name,
        projectId: t.projectId,
        scopes: t.scopes as Array<"admin" | "read">,
        lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
        createdAt: t.createdAt.toISOString(),
      })),
    });
  });

  app.post("/projects/:projectId/tokens", async (c) => {
    const ctx = c.get("ctx");
    const actor = c.get("actor");
    requireAdminScope(actor);
    const project = await authorizeProject(ctx, actor, c.req.param("projectId"));

    const body = z
      .object({
        name: z.string().min(1).max(60),
        scopes: z.array(z.enum(["admin", "read"])).min(1).default(["admin"]),
      })
      .parse(await c.req.json());

    const { id, token } = await issueToken(ctx, {
      userId: actor.userId,
      orgId: project.orgId,
      projectId: project.id,
      name: body.name,
      scopes: body.scopes,
    });

    // The only time the raw token exists outside the client's hands.
    return c.json(
      {
        token: {
          id,
          name: body.name,
          projectId: project.id,
          scopes: body.scopes,
          lastUsedAt: null,
          createdAt: ctx.now().toISOString(),
          token,
        },
      },
      201,
    );
  });

  app.delete("/tokens/:tokenId", async (c) => {
    const ctx = c.get("ctx");
    const actor = c.get("actor");
    requireAdminScope(actor);
    const row = await ctx.db.query.apiTokens.findFirst({ where: eq(apiTokens.id, c.req.param("tokenId")) });
    if (!row || row.orgId !== actor.orgId) throw ApiError.notFound("token_not_found", "No token with that id");
    await ctx.db.delete(apiTokens).where(eq(apiTokens.id, row.id));
    return c.body(null, 204);
  });

  /* ------------------------------------------------------- release lookup */

  app.get("/projects/:projectId/releases/lookup/:ref", async (c) => {
    const ctx = c.get("ctx");
    const project = await authorizeProject(ctx, c.get("actor"), c.req.param("projectId"));
    const platform = c.req.query("platform") as Platform | undefined;
    const release = await findRelease(ctx, project.id, c.req.param("ref"), {
      channel: c.req.query("channel"),
      platform: platform && ["ios", "android"].includes(platform) ? platform : undefined,
    });
    const channel = await ctx.db.query.channels.findFirst({ where: eq(channels.id, release.channelId) });
    return c.json({ release: toReleaseDto(release, channel?.name ?? "") });
  });

  return app;
}

export { requireOrgRole, requireProject, uuidv7 };
