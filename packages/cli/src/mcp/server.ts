/**
 * MCP over stdio. Every tool is a thin wrapper over OtaClient — no business
 * logic lives here, so the remote `/mcp` transport in the server package can
 * bind the same schemas to its own service layer.
 *
 * Nothing may write to stdout: that is the JSON-RPC channel.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { OtaClient, Release } from "@open-ota/shared";

import { renderQr } from "../commands/preview.js";
import { requireRuntimeVersion } from "../fingerprint.js";
import { publishBundleDir } from "../publish.js";
import { otaTools, parseToolInput, type OtaToolName } from "./tools.js";

export interface McpContext {
  client: OtaClient;
  apiUrl: string;
  token: string;
  projectId?: string;
  channel: string;
  projectRoot: string;
}

interface ToolOutput {
  json: unknown;
  /** Rendered ahead of the JSON, for output a human is meant to look at. */
  text?: string;
}

type ToolHandler = (args: unknown) => Promise<ToolOutput>;

export function createHandlers(context: McpContext): Record<OtaToolName, ToolHandler> {
  const { client } = context;
  const project = (given?: string): string => {
    const id = given ?? context.projectId;
    if (!id) throw new Error("No project id: pass projectId, or run this from a directory with ota.config.json.");
    return id;
  };

  /** "v42" and a uuid must both work, exactly as they do over HTTP. */
  const resolveRelease = async (input: {
    projectId?: string;
    release: string;
    channel?: string;
    platform?: "ios" | "android";
  }): Promise<string> => {
    const { release } = await client.lookupRelease(project(input.projectId), input.release, {
      channel: input.channel,
      platform: input.platform,
    });
    return release.id;
  };

  return {
    list_projects: async (args) => ({ json: await client.listProjects(parseToolInput("list_projects", args).orgId) }),

    get_project: async (args) => ({
      json: await client.getProject(project(parseToolInput("get_project", args).projectId)),
    }),

    list_releases: async (args) => {
      const input = parseToolInput("list_releases", args);
      return {
        json: await client.listReleases(project(input.projectId), {
          channel: input.channel,
          platform: input.platform,
          status: input.status,
          limit: input.limit,
        }),
      };
    },

    get_release: async (args) => ({
      json: await client.getRelease(await resolveRelease(parseToolInput("get_release", args))),
    }),

    get_release_metrics: async (args) => {
      const input = parseToolInput("get_release_metrics", args);
      return { json: await client.getReleaseMetrics(await resolveRelease(input), input.days) };
    },

    get_version_distribution: async (args) => {
      const input = parseToolInput("get_version_distribution", args);
      return {
        json: await client.getDistribution(project(input.projectId), {
          platform: input.platform,
          windowDays: input.windowDays,
        }),
      };
    },

    get_rollback_rate: async (args) => {
      const input = parseToolInput("get_rollback_rate", args);
      return {
        json: await rollbackComparison(client, project(input.projectId), {
          channel: input.channel,
          platform: input.platform,
          limit: input.limit,
          days: input.days,
        }),
      };
    },

    publish_release: async (args) => {
      const input = parseToolInput("publish_release", args);
      if (!input.bundleDir || !input.platform) {
        throw new Error("Pass bundleDir and platform — point them at an `expo export` output.");
      }
      const { release, archive } = await publishBundleDir({
        client,
        projectId: project(input.projectId),
        platform: input.platform,
        channel: input.channel ?? context.channel,
        runtimeVersion: input.runtimeVersion ?? requireRuntimeVersion(context.projectRoot),
        bundleDir: input.bundleDir,
        rolloutPercent: input.rolloutPercent,
        mandatory: input.mandatory,
        message: input.message,
        groupId: input.groupId,
        apiUrl: context.apiUrl,
        token: context.token,
      });
      return { json: { release, sha256: archive.sha256, size: archive.bytes.length, files: archive.entryCount } };
    },

    promote_release: async (args) => {
      const input = parseToolInput("promote_release", args);
      const releaseId = await resolveRelease(input);
      return { json: await client.promoteRelease(releaseId, input.toChannel, input.rolloutPercent) };
    },

    pause_release: async (args) => ({
      json: await client.updateRelease(await resolveRelease(parseToolInput("pause_release", args)), { status: "paused" }),
    }),

    resume_release: async (args) => ({
      json: await client.updateRelease(await resolveRelease(parseToolInput("resume_release", args)), { status: "active" }),
    }),

    rollback_release: async (args) => ({
      json: await client.rollbackRelease(await resolveRelease(parseToolInput("rollback_release", args))),
    }),

    set_rollout_percentage: async (args) => {
      const input = parseToolInput("set_rollout_percentage", args);
      return {
        json: await client.updateRelease(await resolveRelease(input), {
          rolloutPercent: input.rolloutPercent,
        }),
      };
    },

    generate_release_deeplink: async (args) => {
      const input = parseToolInput("generate_release_deeplink", args);
      return { json: await client.createPreviewLink(await resolveRelease(input), input.ttlMinutes) };
    },

    generate_release_qrcode: async (args) => {
      const input = parseToolInput("generate_release_qrcode", args);
      const link = await client.createPreviewLink(await resolveRelease(input), input.ttlMinutes);
      return { json: link, text: `${await renderQr(link.url)}\n${link.url}` };
    },
  };
}

/**
 * Recent releases newest first with their rollback rates — which is how
 * "is v52 rolling back more than the one before it" gets answered.
 */
async function rollbackComparison(
  client: OtaClient,
  projectId: string,
  opts: { channel?: string; platform?: "ios" | "android"; limit?: number; days?: number },
): Promise<unknown> {
  const { releases } = await client.listReleases(projectId, {
    channel: opts.channel,
    platform: opts.platform,
    limit: 200,
  });

  const recent = releases.slice(0, opts.limit ?? 5);
  const compared = [];
  for (const release of recent) {
    const metrics = await client.getReleaseMetrics(release.id, opts.days ?? 14);
    compared.push({
      releaseId: release.id,
      label: release.label,
      channel: release.channel,
      platform: release.platform,
      installs: metrics.installs,
      rollbacks: metrics.rollbacks,
      rollbackRate: metrics.rollbackRate,
      successRate: metrics.successRate,
    });
  }
  return { releases: compared };
}

export function createMcpServer(context: McpContext): McpServer {
  const server = new McpServer({ name: "open-ota", version: "0.1.0" });
  const handlers = createHandlers(context);

  for (const tool of otaTools) {
    const run = handlers[tool.name];
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputShape,
        annotations: { readOnlyHint: tool.readOnly },
      },
      // The loop erases each tool's argument type; every handler revalidates
      // against its own zod schema before touching the arguments.
      async (args) => {
        try {
          const output = await run(args);
          const content = [
            ...(output.text ? [{ type: "text" as const, text: output.text }] : []),
            { type: "text" as const, text: JSON.stringify(output.json, null, 2) },
          ];
          return { content };
        } catch (error) {
          return {
            content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
            isError: true,
          };
        }
      },
    );
  }

  return server;
}

export async function startStdioMcpServer(context: McpContext): Promise<void> {
  await createMcpServer(context).connect(new StdioServerTransport());
}
