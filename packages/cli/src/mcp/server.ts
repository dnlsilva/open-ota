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

    get_release: async (args) => ({ json: await client.getRelease(parseToolInput("get_release", args).releaseId) }),

    get_release_metrics: async (args) => {
      const input = parseToolInput("get_release_metrics", args);
      return { json: await client.getReleaseMetrics(input.releaseId, input.days) };
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
      if (input.releaseId) return { json: await rollbackComparison(client, project(input.projectId), input.releaseId) };

      const overview = await client.getOverview(project(input.projectId));
      const channels = overview.channels.filter((entry) => !input.channel || entry.channel === input.channel);
      return { json: { channels } };
    },

    publish_release: async (args) => {
      const input = parseToolInput("publish_release", args);
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
      return { json: await client.promoteRelease(input.releaseId, input.channel, input.rolloutPercent) };
    },

    pause_release: async (args) => ({
      json: await client.updateRelease(parseToolInput("pause_release", args).releaseId, { status: "paused" }),
    }),

    resume_release: async (args) => ({
      json: await client.updateRelease(parseToolInput("resume_release", args).releaseId, { status: "active" }),
    }),

    rollback_release: async (args) => ({
      json: await client.rollbackRelease(parseToolInput("rollback_release", args).releaseId),
    }),

    set_rollout_percentage: async (args) => {
      const input = parseToolInput("set_rollout_percentage", args);
      return {
        json: await client.updateRelease(input.releaseId, { rolloutPercent: input.rolloutPercent }),
      };
    },

    generate_release_deeplink: async (args) => {
      const input = parseToolInput("generate_release_deeplink", args);
      return { json: await client.createPreviewLink(input.releaseId, input.ttlMinutes) };
    },

    generate_release_qrcode: async (args) => {
      const input = parseToolInput("generate_release_qrcode", args);
      const link = await client.createPreviewLink(input.releaseId, input.ttlMinutes);
      return { json: link, text: `${await renderQr(link.url)}\n${link.url}` };
    },
  };
}

async function rollbackComparison(
  client: OtaClient,
  projectId: string,
  releaseId: string,
): Promise<unknown> {
  const [{ release }, metrics] = await Promise.all([
    client.getRelease(releaseId),
    client.getReleaseMetrics(releaseId),
  ]);

  const { releases } = await client.listReleases(projectId, {
    channel: release.channel,
    platform: release.platform,
    limit: 200,
  });
  const previous = releases
    .filter((candidate: Release) => candidate.label < release.label)
    .sort((a: Release, b: Release) => b.label - a.label)[0];
  const previousMetrics = previous ? await client.getReleaseMetrics(previous.id) : null;

  return {
    release: { id: release.id, label: release.label, platform: release.platform, channel: release.channel },
    rollbackRate: metrics.rollbackRate,
    rollbacks: metrics.rollbacks,
    installs: metrics.installs,
    previous: previousMetrics
      ? {
          id: previousMetrics.releaseId,
          label: previousMetrics.label,
          rollbackRate: previousMetrics.rollbackRate,
          rollbacks: previousMetrics.rollbacks,
          installs: previousMetrics.installs,
        }
      : null,
    delta:
      previousMetrics && metrics.rollbackRate !== null && previousMetrics.rollbackRate !== null
        ? metrics.rollbackRate - previousMetrics.rollbackRate
        : null,
  };
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
