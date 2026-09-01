/**
 * The MCP surface is exposed twice — over stdio by the CLI and over HTTP by
 * this server — and the whole point is that an agent sees the same tools
 * whichever way it connects. The shared package owns the contract; this asserts
 * the server's implementations still match it, so the two cannot drift apart
 * without a red test saying exactly what moved.
 */

import { otaToolByName, otaTools, type OtaToolName } from "@open-ota/shared";
import { describe, expect, it } from "vitest";
import { MCP_TOOLS, findTool } from "../src/mcp/tools.js";

const sharedNames = otaTools.map((t) => t.name).sort();
const serverNames = MCP_TOOLS.map((t) => t.name).sort();

describe("MCP tool contract", () => {
  it("exposes exactly the tools the shared contract declares", () => {
    expect(serverNames).toEqual(sharedNames);
  });

  it("gives every tool the same description on both transports", () => {
    for (const tool of MCP_TOOLS) {
      const shared = otaToolByName[tool.name as OtaToolName];
      expect(shared, `${tool.name} is missing from the shared contract`).toBeDefined();
      expect(tool.description, `${tool.name} description drifted`).toBe(shared.description);
    }
  });

  it("accepts the same arguments on both transports", () => {
    for (const tool of MCP_TOOLS) {
      const shared = otaToolByName[tool.name as OtaToolName];
      expect(Object.keys(tool.input).sort(), `${tool.name} arguments drifted`).toEqual(
        Object.keys(shared.inputShape).sort(),
      );
    }
  });

  it("resolves every declared tool by name", () => {
    for (const name of sharedNames) expect(findTool(name)).toBeDefined();
    expect(findTool("no_such_tool")).toBeUndefined();
  });

  it("still covers the operations the platform promises an agent", () => {
    // Named explicitly: dropping one of these silently would quietly remove a
    // capability the product is sold on.
    expect(serverNames).toEqual(
      expect.arrayContaining([
        "list_projects",
        "list_releases",
        "get_release_metrics",
        "get_version_distribution",
        "get_rollback_rate",
        "publish_release",
        "promote_release",
        "pause_release",
        "rollback_release",
        "set_rollout_percentage",
        "generate_release_deeplink",
        "generate_release_qrcode",
      ]),
    );
  });
});
