/**
 * MCP tool definitions — one set, two transports: the `/mcp` route on this
 * server and the CLI's `ota mcp` stdio server. docs/ARCHITECTURE.md §3.5.
 *
 * `name`, `description` and `input` are the shared contract; `run` is the
 * server-side implementation over the service layer. The CLI imports the first
 * three and supplies its own `run` over OtaClient.
 */

import {
  createPreviewToken,
  decryptSecret,
  PREVIEW_DEFAULT_TTL_MINUTES,
  previewDeepLink,
  sha256Hex,
  type Platform,
} from "@open-ota/shared";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { channels, projects, releases, type ProjectRow, type ReleaseRow } from "../db/schema.js";
import { authorizeProject, requireAdminScope } from "../services/auth.js";
import type { Actor, AppContext } from "../services/context.js";
import { DEFAULT_WINDOW_DAYS, getDistribution, getReleaseMetrics, toReleaseDto } from "../services/metrics.js";
import { ApiError } from "../services/errors.js";
import { assertCanPublish } from "../services/orgs.js";
import { toProjectDto } from "../services/projects.js";
import {
  confirmRelease,
  findRelease,
  prepareUpload,
  promoteRelease,
  rollbackRelease,
  updateRelease,
} from "../services/releases.js";

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
  /** MCP lets a result carry `_meta` and future fields; the SDK's type demands it. */
  [key: string]: unknown;
}

export interface McpTool {
  name: string;
  description: string;
  /** Raw Zod shape — what both the MCP SDK and the CLI want for a tool schema. */
  input: z.ZodRawShape;
  run(ctx: AppContext, actor: Actor, args: Record<string, unknown>): Promise<ToolResult>;
}

const json = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});

function tool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  input: S,
  run: (ctx: AppContext, actor: Actor, args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>,
): McpTool {
  return {
    name,
    description,
    input,
    // Parsed again here because the CLI transport may hand args straight through.
    run: (ctx, actor, args) => run(ctx, actor, z.object(input).parse(args)),
  };
}

/* ------------------------------------------------------------- arg shapes */

const platformArg = z.enum(["ios", "android"]);

const projectArg = {
  projectId: z.string().uuid().describe("Project id, from list_projects"),
};

const releaseArg = {
  ...projectArg,
  release: z.string().describe('Release id, or a label such as "v42"'),
  platform: platformArg.optional().describe("Required when the same label exists on both platforms"),
  channel: z.string().optional().describe("Narrows the label lookup to one channel"),
};

type ReleaseArgs = z.infer<z.ZodObject<typeof releaseArg>>;

async function resolveRelease(ctx: AppContext, actor: Actor, a: ReleaseArgs) {
  const project = await authorizeProject(ctx, actor, a.projectId);
  const release = await findRelease(ctx, project.id, a.release, {
    channel: a.channel,
    platform: a.platform,
  });
  return { project, release };
}

async function channelName(ctx: AppContext, release: ReleaseRow): Promise<string> {
  const row = await ctx.db.query.channels.findFirst({ where: eq(channels.id, release.channelId) });
  return row?.name ?? "";
}

async function releaseDto(ctx: AppContext, release: ReleaseRow) {
  return toReleaseDto(release, await channelName(ctx, release));
}

/** Both link tools want the same signed token; only the presentation differs. */
async function previewUrl(
  ctx: AppContext,
  project: ProjectRow,
  release: ReleaseRow,
  ttlMinutes: number,
): Promise<{ url: string; expiresAt: string; scheme: string }> {
  if (!project.deepLinkScheme) {
    throw ApiError.badRequest(
      "no_deep_link_scheme",
      "Set a deep link scheme on this project before generating preview links",
    );
  }
  const privateKeyPem = await decryptSecret(project.privateKeyEnc, ctx.config.OTA_MASTER_KEY);
  const link = await createPreviewToken(
    { projectId: project.id, releaseId: release.id, ttlMinutes },
    privateKeyPem,
    ctx.now().getTime(),
  );
  return {
    url: previewDeepLink(project.deepLinkScheme, link),
    expiresAt: new Date(link.payload.exp * 1000).toISOString(),
    scheme: project.deepLinkScheme,
  };
}

/* ------------------------------------------------------------------ tools */

export const MCP_TOOLS: McpTool[] = [
  tool(
    "list_projects",
    "Lists the projects this token can see, with their app keys and deep link schemes.",
    {},
    async (ctx, actor) => {
      const rows = await ctx.db
        .select()
        .from(projects)
        .where(eq(projects.orgId, actor.orgId))
        .orderBy(desc(projects.createdAt));
      const visible = actor.projectId ? rows.filter((r) => r.id === actor.projectId) : rows;
      return json({ projects: visible.map(toProjectDto) });
    },
  ),

  tool("get_project", "Fetches one project by id.", projectArg, async (ctx, actor, a) => {
    return json({ project: toProjectDto(await authorizeProject(ctx, actor, a.projectId)) });
  }),

  tool(
    "list_releases",
    "Lists releases newest first, optionally filtered by channel, platform or status.",
    {
      ...projectArg,
      channel: z.string().optional(),
      platform: platformArg.optional(),
      status: z.enum(["pending", "active", "paused", "disabled"]).optional(),
      limit: z.number().int().min(1).max(200).optional().describe("Default 20"),
    },
    async (ctx, actor, a) => {
      const project = await authorizeProject(ctx, actor, a.projectId);
      const conditions = [eq(releases.projectId, project.id)];
      if (a.platform) conditions.push(eq(releases.platform, a.platform));
      if (a.status) conditions.push(eq(releases.status, a.status));
      if (a.channel) {
        const channel = await ctx.db.query.channels.findFirst({
          where: and(eq(channels.projectId, project.id), eq(channels.name, a.channel)),
        });
        if (!channel) return json({ releases: [] });
        conditions.push(eq(releases.channelId, channel.id));
      }

      const rows = await ctx.db
        .select({ release: releases, channelName: channels.name })
        .from(releases)
        .innerJoin(channels, eq(channels.id, releases.channelId))
        .where(and(...conditions))
        .orderBy(desc(releases.id))
        .limit(a.limit ?? 20);

      return json({ releases: rows.map((r) => toReleaseDto(r.release, r.channelName)) });
    },
  ),

  tool("get_release", "Fetches one release by id or label.", releaseArg, async (ctx, actor, a) => {
    const { release } = await resolveRelease(ctx, actor, a);
    return json({ release: await releaseDto(ctx, release) });
  }),

  tool(
    "get_release_metrics",
    "Adoption funnel for one release — download, install, ready, failed, rollback — plus the daily series and its success and rollback rates.",
    { ...releaseArg, days: z.number().int().min(1).max(90).optional().describe("Default 14") },
    async (ctx, actor, a) => {
      const { release } = await resolveRelease(ctx, actor, a);
      return json(await getReleaseMetrics(ctx, release.id, a.days ?? 14));
    },
  ),

  tool(
    "get_version_distribution",
    "How the active device base is split across OTA releases and native app versions. Answers questions like \"what percentage is still on v41?\".",
    {
      ...projectArg,
      platform: platformArg.optional(),
      windowDays: z.number().int().min(1).max(365).optional().describe(`Active window, default ${DEFAULT_WINDOW_DAYS}`),
    },
    async (ctx, actor, a) => {
      const project = await authorizeProject(ctx, actor, a.projectId);
      return json(
        await getDistribution(ctx, project.id, { platform: a.platform, windowDays: a.windowDays }),
      );
    },
  ),

  tool(
    "get_rollback_rate",
    "Rollback rate for the most recent releases, newest first, so two releases can be compared directly.",
    {
      ...projectArg,
      channel: z.string().optional(),
      platform: platformArg.optional(),
      limit: z.number().int().min(1).max(20).optional().describe("How many releases to compare, default 5"),
      days: z.number().int().min(1).max(90).optional().describe("Default 14"),
    },
    async (ctx, actor, a) => {
      const project = await authorizeProject(ctx, actor, a.projectId);
      const conditions = [eq(releases.projectId, project.id)];
      if (a.platform) conditions.push(eq(releases.platform, a.platform));
      if (a.channel) {
        const channel = await ctx.db.query.channels.findFirst({
          where: and(eq(channels.projectId, project.id), eq(channels.name, a.channel)),
        });
        if (!channel) return json({ releases: [] });
        conditions.push(eq(releases.channelId, channel.id));
      }

      const rows = await ctx.db
        .select({ release: releases, channelName: channels.name })
        .from(releases)
        .innerJoin(channels, eq(channels.id, releases.channelId))
        .where(and(...conditions))
        .orderBy(desc(releases.id))
        .limit(a.limit ?? 5);

      const compared = [];
      for (const row of rows) {
        const m = await getReleaseMetrics(ctx, row.release.id, a.days ?? 14);
        compared.push({
          releaseId: row.release.id,
          label: row.release.label,
          channel: row.channelName,
          platform: row.release.platform,
          installs: m.installs,
          rollbacks: m.rollbacks,
          rollbackRate: m.rollbackRate,
          successRate: m.successRate,
        });
      }
      return json({ releases: compared });
    },
  ),

  tool(
    "publish_release",
    "Publishes a bundle that already exists. It never runs a build: pass releaseId to confirm and activate a release whose bundle is already uploaded, or bundlePath to upload a .zip that `ota publish` (or `expo export` plus zip) already produced. bundlePath is read from the filesystem of the machine running this MCP server, so over the remote /mcp transport only releaseId is usable.",
    {
      ...projectArg,
      releaseId: z.string().uuid().optional().describe("A release created by prepare-upload whose bundle is uploaded"),
      bundlePath: z.string().optional().describe("Absolute path to a prepared bundle .zip"),
      platform: platformArg.optional().describe("Required with bundlePath"),
      channel: z.string().optional().describe("Required with bundlePath"),
      runtimeVersion: z.string().optional().describe("Required with bundlePath — the binary fingerprint"),
      rolloutPercent: z.number().min(0).max(100).optional(),
      mandatory: z.boolean().optional(),
      message: z.string().max(500).optional(),
    },
    async (ctx, actor, a) => {
      requireAdminScope(actor);
      const project = await authorizeProject(ctx, actor, a.projectId);

      if (a.releaseId) {
        const confirmed = await confirmRelease(ctx, a.releaseId);
        if (confirmed.projectId !== project.id) {
          throw ApiError.notFound("release_not_found", "No release with that id");
        }
        return json({ release: await releaseDto(ctx, confirmed) });
      }

      if (!a.bundlePath || !a.platform || !a.channel || !a.runtimeVersion) {
        throw ApiError.badRequest(
          "missing_bundle",
          "Pass releaseId, or bundlePath with platform, channel and runtimeVersion",
        );
      }

      // node:fs only on this branch: the module has to stay importable on
      // Workers and Deno, where a local bundle path cannot exist anyway.
      const { readFile } = await import("node:fs/promises");
      const bytes = new Uint8Array(await readFile(a.bundlePath));
      await assertCanPublish(ctx, project.orgId, bytes.byteLength);

      const prepared = await prepareUpload(ctx, {
        projectId: project.id,
        createdBy: actor.userId,
        platform: a.platform,
        channel: a.channel,
        runtimeVersion: a.runtimeVersion,
        sha256: await sha256Hex(bytes),
        size: bytes.byteLength,
        rolloutPercent: a.rolloutPercent,
        mandatory: a.mandatory,
        message: a.message,
      });

      if (ctx.storage.put) {
        await ctx.storage.put(prepared.storageKey, bytes, "application/zip");
      } else {
        const res = await fetch(prepared.uploadUrl, {
          method: "PUT",
          headers: prepared.uploadHeaders,
          body: bytes,
        });
        if (!res.ok) {
          throw ApiError.badRequest("upload_failed", `Storage rejected the bundle (HTTP ${res.status})`);
        }
      }

      const confirmed = await confirmRelease(ctx, prepared.releaseId);
      return json({ release: await releaseDto(ctx, confirmed) });
    },
  ),

  tool(
    "promote_release",
    "Copies a release into another channel as a new release with the same bundle. The source channel keeps its history.",
    {
      ...releaseArg,
      toChannel: z.string().min(1).max(64).describe("Destination channel, e.g. production"),
      rolloutPercent: z.number().min(0).max(100).optional().describe("Rollout in the destination, default 100"),
    },
    async (ctx, actor, a) => {
      requireAdminScope(actor);
      const { release } = await resolveRelease(ctx, actor, a);
      const promoted = await promoteRelease(ctx, release.id, a.toChannel, a.rolloutPercent);
      return json({ release: toReleaseDto(promoted, a.toChannel) });
    },
  ),

  tool(
    "pause_release",
    "Stops offering a release to new devices. Devices already on it keep it — only rollback_release pulls them off.",
    releaseArg,
    async (ctx, actor, a) => {
      requireAdminScope(actor);
      const { release } = await resolveRelease(ctx, actor, a);
      return json({ release: await releaseDto(ctx, await updateRelease(ctx, release.id, { status: "paused" })) });
    },
  ),

  tool("resume_release", "Offers a paused release to new devices again.", releaseArg, async (ctx, actor, a) => {
    requireAdminScope(actor);
    const { release } = await resolveRelease(ctx, actor, a);
    return json({ release: await releaseDto(ctx, await updateRelease(ctx, release.id, { status: "active" })) });
  }),

  tool(
    "rollback_release",
    "Disables a release and reports where its devices land — the previous active release, or the bundle embedded in the binary.",
    releaseArg,
    async (ctx, actor, a) => {
      requireAdminScope(actor);
      const { release } = await resolveRelease(ctx, actor, a);
      const { release: disabled, target } = await rollbackRelease(ctx, release.id);
      return json({
        release: await releaseDto(ctx, disabled),
        target: target ? await releaseDto(ctx, target) : null,
      });
    },
  ),

  tool(
    "set_rollout_percentage",
    "Sets what share of devices are offered a release. Raising it only adds devices; lowering it never removes devices that already installed.",
    { ...releaseArg, percent: z.number().min(0).max(100).describe("0–100") },
    async (ctx, actor, a) => {
      requireAdminScope(actor);
      const { release } = await resolveRelease(ctx, actor, a);
      const updated = await updateRelease(ctx, release.id, { rolloutPercent: a.percent });
      return json({ release: await releaseDto(ctx, updated) });
    },
  ),

  tool(
    "generate_release_deeplink",
    "Creates a short-lived signed deep link that installs one specific release on a device, bypassing the rollout. Needs a deep link scheme on the project.",
    {
      ...releaseArg,
      ttlMinutes: z.number().int().min(1).max(1440).optional().describe(`Default ${PREVIEW_DEFAULT_TTL_MINUTES}`),
    },
    async (ctx, actor, a) => {
      requireAdminScope(actor);
      const { project, release } = await resolveRelease(ctx, actor, a);
      return json(await previewUrl(ctx, project, release, a.ttlMinutes ?? PREVIEW_DEFAULT_TTL_MINUTES));
    },
  ),

  tool(
    "generate_release_qrcode",
    "Returns the preview deep link to render as a QR code. This server has no QR renderer, so it returns the URL as text rather than an image — `ota preview` renders it in the terminal and the dashboard renders it in the browser.",
    {
      ...releaseArg,
      ttlMinutes: z.number().int().min(1).max(1440).optional().describe(`Default ${PREVIEW_DEFAULT_TTL_MINUTES}`),
    },
    async (ctx, actor, a) => {
      requireAdminScope(actor);
      const { project, release } = await resolveRelease(ctx, actor, a);
      const link = await previewUrl(ctx, project, release, a.ttlMinutes ?? PREVIEW_DEFAULT_TTL_MINUTES);
      // ponytail: no QR here. The two packages that show QR codes already carry
      // a renderer (dashboard: qrcode, CLI: qrcode-terminal) and apps/server
      // carries none; hand-rolling an encoder that no scanner has checked is
      // worse than handing back the URL. Add `qrcode` to apps/server and return
      // an image content block if an agent ever needs to display it inline.
      return {
        content: [
          { type: "text", text: `Render this as a QR code (expires ${link.expiresAt}):\n${link.url}` },
        ],
      };
    },
  ),
];

export function findTool(name: string): McpTool | undefined {
  return MCP_TOOLS.find((t) => t.name === name);
}
