import { mkdtemp, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_CHANNEL,
  envConfig,
  findProjectRoot,
  globalConfigPath,
  loadGlobalConfig,
  mergeConfig,
  saveGlobalConfig,
} from "../src/config.js";

const project = {
  projectId: "prj_from_file",
  apiUrl: "https://file.example",
  channel: "staging",
  runtimeVersion: { policy: "fingerprint" } as const,
};
const globalConfig = { apiUrl: "https://global.example", token: "ota_global" };

describe("config precedence", () => {
  it("prefers flags over everything", () => {
    const merged = mergeConfig({
      flags: { apiUrl: "https://flag.example", projectId: "prj_flag", channel: "canary", token: "ota_flag" },
      env: { apiUrl: "https://env.example", projectId: "prj_env", channel: "env", token: "ota_env" },
      project,
      global: globalConfig,
    });
    expect(merged).toMatchObject({
      apiUrl: "https://flag.example",
      projectId: "prj_flag",
      channel: "canary",
      token: "ota_flag",
    });
  });

  it("prefers env over the project file", () => {
    const merged = mergeConfig({
      env: { apiUrl: "https://env.example", projectId: "prj_env", channel: "env" },
      project,
      global: globalConfig,
    });
    expect(merged).toMatchObject({ apiUrl: "https://env.example", projectId: "prj_env", channel: "env" });
  });

  it("prefers the project file over the global file", () => {
    const merged = mergeConfig({ project, global: globalConfig });
    expect(merged.apiUrl).toBe("https://file.example");
    expect(merged.projectId).toBe("prj_from_file");
    expect(merged.channel).toBe("staging");
  });

  it("falls back to the global file, and only it carries the token", () => {
    const merged = mergeConfig({ global: globalConfig });
    expect(merged.apiUrl).toBe("https://global.example");
    expect(merged.token).toBe("ota_global");
    expect(merged.channel).toBe(DEFAULT_CHANNEL);
  });

  it("ignores empty strings", () => {
    const merged = mergeConfig({ flags: { apiUrl: "" }, env: { apiUrl: "" }, project, global: globalConfig });
    expect(merged.apiUrl).toBe("https://file.example");
  });

  it("reads the documented environment variables", () => {
    expect(
      envConfig({
        OTA_API_URL: "https://env.example",
        OTA_TOKEN: "ota_env",
        OTA_PROJECT_ID: "prj_env",
        OTA_CHANNEL: "beta",
      } as NodeJS.ProcessEnv),
    ).toEqual({
      apiUrl: "https://env.example",
      token: "ota_env",
      projectId: "prj_env",
      channel: "beta",
    });
  });
});

describe("config files", () => {
  const originalHome = process.env.XDG_CONFIG_HOME;

  afterEach(() => {
    if (originalHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalHome;
  });

  it("writes the credentials file 0600", async () => {
    process.env.XDG_CONFIG_HOME = await mkdtemp(join(tmpdir(), "ota-xdg-"));
    const path = saveGlobalConfig({ apiUrl: "https://a.example", token: "ota_secret" });

    expect(path).toBe(globalConfigPath());
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadGlobalConfig()).toEqual({ apiUrl: "https://a.example", token: "ota_secret" });
  });

  it("finds the project root by walking up to ota.config.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "ota-root-"));
    await writeFile(join(root, "ota.config.json"), JSON.stringify(project));
    expect(findProjectRoot(root)).toBe(root);
  });
});
