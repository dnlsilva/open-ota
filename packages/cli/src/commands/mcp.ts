import type { Command } from "commander";

import { createClient } from "../client.js";
import { requireApi, resolveConfig } from "../config.js";
import { info } from "../output.js";
import { startStdioMcpServer } from "../mcp/server.js";

export function registerMcp(program: Command): void {
  program
    .command("mcp")
    .description("run the Open OTA MCP server over stdio")
    .option("--project <id>", "default project id for tools that omit one")
    .option("-c, --channel <name>", "default channel for publish_release")
    .action(async (flags: { project?: string; channel?: string }) => {
      const config = resolveConfig({ projectId: flags.project, channel: flags.channel });
      const { apiUrl, token } = requireApi(config);

      // stdout is the JSON-RPC channel; anything human goes to stderr.
      info(`Open OTA MCP server on stdio → ${apiUrl}`);
      await startStdioMcpServer({
        client: createClient(config),
        apiUrl,
        token,
        projectId: config.projectId,
        channel: config.channel,
        projectRoot: config.projectRoot,
      });
    });
}
