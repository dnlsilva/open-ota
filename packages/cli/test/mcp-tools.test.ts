import { describe, expect, it } from "vitest";

import { otaToolByName, otaTools, parseToolInput, toolSchema } from "../src/mcp/tools.js";

const EXPECTED = [
  "list_projects",
  "get_project",
  "list_releases",
  "get_release",
  "get_release_metrics",
  "get_version_distribution",
  "get_rollback_rate",
  "publish_release",
  "promote_release",
  "pause_release",
  "resume_release",
  "rollback_release",
  "set_rollout_percentage",
  "generate_release_deeplink",
  "generate_release_qrcode",
];

describe("mcp tool definitions", () => {
  it("exposes the tools from ARCHITECTURE §3.5", () => {
    expect(otaTools.map((tool) => tool.name)).toEqual(EXPECTED);
  });

  it("describes every tool and marks the read-only ones", () => {
    for (const tool of otaTools) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(otaToolByName[tool.name]).toBe(tool);
    }
    expect(otaToolByName.list_releases.readOnly).toBe(true);
    expect(otaToolByName.publish_release.readOnly).toBe(false);
  });
});

describe("mcp tool validation", () => {
  it("accepts a valid rollout change", () => {
    expect(parseToolInput("set_rollout_percentage", { releaseId: "rel_1", rolloutPercent: 25 })).toEqual({
      releaseId: "rel_1",
      rolloutPercent: 25,
    });
  });

  it("rejects a rollout outside 0-100", () => {
    expect(() => parseToolInput("set_rollout_percentage", { releaseId: "rel_1", rolloutPercent: 101 })).toThrow(
      /rolloutPercent/,
    );
    expect(toolSchema("set_rollout_percentage").safeParse({ releaseId: "r", rolloutPercent: 12.5 }).success).toBe(
      false,
    );
  });

  it("requires the arguments a tool cannot default", () => {
    expect(() => parseToolInput("get_release", {})).toThrow(/releaseId/);
    expect(() => parseToolInput("publish_release", { platform: "ios" })).toThrow(/bundleDir/);
    expect(() => parseToolInput("promote_release", { releaseId: "r" })).toThrow(/channel/);
  });

  it("lets the project id default to the configured one", () => {
    expect(parseToolInput("list_releases", {})).toEqual({});
    expect(parseToolInput("list_projects", undefined)).toEqual({});
  });

  it("rejects an unknown platform or status", () => {
    expect(() => parseToolInput("list_releases", { platform: "web" })).toThrow(/platform/);
    expect(() => parseToolInput("list_releases", { status: "cancelled" })).toThrow(/status/);
  });

  it("never lets publish_release take a build command", () => {
    expect(Object.keys(otaToolByName.publish_release.inputShape)).not.toContain("command");
    expect(Object.keys(otaToolByName.publish_release.inputShape)).toContain("bundleDir");
  });
});
