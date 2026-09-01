/**
 * Server-side implementations of the MCP tools.
 *
 * The contract — name, description and argument schema — lives in
 * @open-ota/shared and is the same object the CLI's stdio server uses, so an
 * agent sees an identical surface whichever transport it connects over. This
 * file supplies only `run`. test/mcp-contract.test.ts keeps the two honest.
 */

import {
  createPreviewToken,
  decryptSecret,
  otaToolByName,
  PREVIEW_DEFAULT_TTL_MINUTES,
  previewDeepLink,
  sha256Hex,
  type OtaToolInput,
  type OtaToolName,
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

/**
 * Binds a handler to a tool declared in the shared contract. Description and
 * schema are read from there rather than repeated here, so the two transports
 * cannot describe the same tool differently.
 */
function tool<N extends OtaToolName>(
  name: N,
  run: (ctx: AppContext, actor: Actor, args: OtaToolInput<N>) => Promise<ToolResult>,
): McpTool {
  const declared = otaToolByName[name];
  return {
    name,
    description: declared.description,
    input: declared.inputShape,
    // Parsed again here because a transport may hand arguments straight through.
    run: (ctx, actor, args) => run(ctx, actor, z.object(declared.inputShape).parse(args) as OtaToolInput<N>),
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

type ReleaseArgs = OtaToolInput<"get_release">;

/**
 * The contract makes projectId optional because the CLI fills it from
 * ota.config.json. There is no such file on the server, so a project-scoped
 * token supplies it and anything else has to say which project it means.
 */
function requireProjectId(actor: Actor, given: string | undefined): string {
  const projectId = given ?? actor.projectId;
  if (!projectId) {
    throw ApiError.badRequest(
      "project_required",
      "Pass projectId — list_projects will give you one, or use a token scoped to a single project",
    );
  }
  return projectId;
}

async function resolveRelease(ctx: AppContext, actor: Actor, a: ReleaseArgs) {
  const project = await authorizeProject(ctx, actor, requireProjectId(actor, a.projectId));
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

  tool(
    "get_project",
    async (ctx, actor, a) => {
    return json({ project: toProjectDto(await authorizeProject(ctx, actor, requireProjectId(actor, a.projectId))) });
  },
  ),

  tool(
    "list_releases",
    async (ctx, actor, a) => {
      const project = await authorizeProject(ctx, actor, requireProjectId(actor, a.projectId));
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

  tool(
    "get_release",
    async (ctx, actor, a) => {
    const { release } = await resolveRelease(ctx, actor, a);
    return json({ release: await releaseDto(ctx, release) });
  },
  ),

  tool(
    "get_release_metrics",
    async (ctx, actor, a) => {
      const { release } = await resolveRelease(ctx, actor, a);
      return json(await getReleaseMetrics(ctx, release.id, a.days ?? 14));
    },
  ),

  tool(
    "get_version_distribution",
    async (ctx, actor, a) => {
      const project = await authorizeProject(ctx, actor, requireProjectId(actor, a.projectId));
      return json(
        await getDistribution(ctx, project.id, { platform: a.platform, windowDays: a.windowDays }),
      );
    },
  ),

  tool(
    "get_rollback_rate",
    async (ctx, actor, a) => {
      const project = await authorizeProject(ctx, actor, requireProjectId(actor, a.projectId));
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
    async (ctx, actor, a) => {
      requireAdminScope(actor);
      const project = await authorizeProject(ctx, actor, requireProjectId(actor, a.projectId));

      if (a.releaseId) {
        const confirmed = await confirmRelease(ctx, a.releaseId);
        if (confirmed.projectId !== project.id) {
          throw ApiError.notFound("release_not_found", "No release with that id");
        }
        return json({ release: await releaseDto(ctx, confirmed) });
      }

      // Deliberately no filesystem branch. Reading a caller-supplied path here
      // would let any admin token make the server disclose its own disk, and a
      // remote agent has no files on this machine anyway. Building and
      // uploading is the CLI's job; this tool only confirms the result.
      throw ApiError.badRequest(
        "release_id_required",
        a.bundleDir
          ? "bundleDir only works over stdio, where the tool runs on the machine holding the files. Run `ota publish` and pass the releaseId it prints."
          : "Pass releaseId — run `ota publish` to build and upload, then confirm it here.",
      );
    },
  ),

  tool(
    "promote_release",
    async (ctx, actor, a) => {
      requireAdminScope(actor);
      const { release } = await resolveRelease(ctx, actor, a);
      const promoted = await promoteRelease(ctx, release.id, a.toChannel, a.rolloutPercent);
      return json({ release: toReleaseDto(promoted, a.toChannel) });
    },
  ),

  tool(
    "pause_release",
    async (ctx, actor, a) => {
      requireAdminScope(actor);
      const { release } = await resolveRelease(ctx, actor, a);
      return json({ release: await releaseDto(ctx, await updateRelease(ctx, release.id, { status: "paused" })) });
    },
  ),

  tool(
    "resume_release",
    async (ctx, actor, a) => {
    requireAdminScope(actor);
    const { release } = await resolveRelease(ctx, actor, a);
    return json({ release: await releaseDto(ctx, await updateRelease(ctx, release.id, { status: "active" })) });
  },
  ),

  tool(
    "rollback_release",
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
    async (ctx, actor, a) => {
      requireAdminScope(actor);
      const { release } = await resolveRelease(ctx, actor, a);
      const updated = await updateRelease(ctx, release.id, { rolloutPercent: a.rolloutPercent });
      return json({ release: await releaseDto(ctx, updated) });
    },
  ),

  tool(
    "generate_release_deeplink",
    async (ctx, actor, a) => {
      requireAdminScope(actor);
      const { project, release } = await resolveRelease(ctx, actor, a);
      return json(await previewUrl(ctx, project, release, a.ttlMinutes ?? PREVIEW_DEFAULT_TTL_MINUTES));
    },
  ),

  tool(
    "generate_release_qrcode",
    async (ctx, actor, a) => {
      requireAdminScope(actor);
      const { project, release } = await resolveRelease(ctx, actor, a);
      const link = await previewUrl(ctx, project, release, a.ttlMinutes ?? PREVIEW_DEFAULT_TTL_MINUTES);

      // The URL rides along with the image: a client that cannot display an
      // image block still gets something the user can act on.
      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
        { type: "text", text: `Preview link for v${release.label} (${release.platform}), expires ${link.expiresAt}:\n${link.url}` },
      ];

      try {
        const { toBuffer } = await import("qrcode");
        const png = await toBuffer(link.url, { type: "png", width: 512, margin: 2 });
        content.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
      } catch (error) {
        content.push({
          type: "text",
          text: `Could not render the QR image (${(error as Error).message}); scan or open the URL above instead.`,
        });
      }

      return { content };
    },
  ),
];

export function findTool(name: string): McpTool | undefined {
  return MCP_TOOLS.find((t) => t.name === name);
}
