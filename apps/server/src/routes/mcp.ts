/**
 * Remote MCP endpoint (Streamable HTTP), authenticated by the same Bearer
 * tokens as the rest of the Admin API — an OAuth access token from /oauth, or a
 * token created by hand in settings. docs/ARCHITECTURE.md §3.5.
 *
 * Transport: the SDK's WebStandardStreamableHTTPServerTransport, which speaks
 * Request/Response, so it drops into Hono as `handleRequest(c.req.raw)` and
 * still runs on Workers and Deno. (StreamableHTTPServerTransport is the
 * node:http wrapper and would pin this route to the Node target.) Hand-rolling
 * the JSON-RPC layer would have been more code than this, not less.
 *
 * Stateless: a server and transport are built per request. Nothing survives
 * between calls, which is the only thing that works on an edge runtime where
 * the next request may land in a different isolate.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Hono } from "hono";
import type { AppEnv } from "../app.js";
import { MCP_TOOLS } from "../mcp/tools.js";
import { authenticate } from "../services/auth.js";
import type { Actor, AppContext } from "../services/context.js";
import { ApiError } from "../services/errors.js";

export function mcpRoutes() {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const ctx = c.get("ctx");
    try {
      c.set("actor", await authenticate(ctx, c.req.header("authorization")));
    } catch {
      // The resource_metadata pointer is what makes a client start the OAuth
      // flow by itself instead of just failing. RFC 9728 §5.3.
      return c.json({ error: "invalid_token", error_description: "A Bearer token is required" }, 401, {
        "www-authenticate": `Bearer resource_metadata="${ctx.config.publicUrl}/.well-known/oauth-protected-resource"`,
      });
    }
    await next();
  });

  app.post("/", async (c) => {
    const server = buildServer(c.get("ctx"), c.get("actor"));
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      // JSON, not SSE: nothing here streams, and a fully materialised response
      // is what lets the server be torn down at the end of the request.
      enableJsonResponse: true,
    });

    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });

  // No server-initiated messages, so there is no stream to open or session to
  // delete. 405 is what the Streamable HTTP spec expects in that case.
  app.all("/", (c) =>
    c.json(
      {
        jsonrpc: "2.0",
        error: { code: -32000, message: "This endpoint accepts POST only" },
        id: null,
      },
      405,
    ),
  );

  return app;
}

function buildServer(ctx: AppContext, actor: Actor): McpServer {
  const server = new McpServer(
    { name: "open-ota", version: "0.1.0" },
    { instructions: "Manage Open OTA projects, releases, rollouts and adoption metrics." },
  );

  for (const tool of MCP_TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.input },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        try {
          return await tool.run(ctx, actor, args ?? {});
        } catch (err) {
          // An ApiError is a message for the operator, not a transport failure:
          // hand it back as tool output so the agent can act on it.
          return { content: [{ type: "text", text: describe(err) }], isError: true };
        }
      },
    );
  }

  return server;
}

function describe(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
