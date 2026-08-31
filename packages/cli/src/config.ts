/**
 * Configuration resolution.
 *
 * Precedence, highest first: CLI flags → environment → ota.config.json (project,
 * committed) → ~/.config/open-ota/config.json (machine, holds the token).
 * The split is deliberate: the project file is safe to commit, the machine file
 * is written 0600 and never is.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { fail } from "./output.js";

export const PROJECT_CONFIG_FILE = "ota.config.json";
export const FINGERPRINT_FILE = "fingerprint.json";
export const DEFAULT_CHANNEL = "production";

export type RuntimeVersionPolicy = { policy: "fingerprint" };

export interface ProjectConfig {
  projectId: string;
  apiUrl: string;
  channel: string;
  deepLinkScheme?: string;
  /** PEM of the project's RSA public key — embedded in the binary by the plugin. */
  publicKey?: string;
  runtimeVersion: RuntimeVersionPolicy;
}

export interface GlobalConfig {
  apiUrl?: string;
  token?: string;
}

export interface ConfigFlags {
  apiUrl?: string;
  token?: string;
  projectId?: string;
  channel?: string;
}

export interface ResolvedConfig extends ConfigFlags {
  channel: string;
  deepLinkScheme?: string;
  publicKey?: string;
  projectRoot: string;
  projectConfigPath: string;
  project: ProjectConfig | null;
}

/* --------------------------------------------------------------- pure merge */

export interface ConfigSources {
  flags?: ConfigFlags;
  env?: ConfigFlags;
  project?: Partial<ProjectConfig> | null;
  global?: GlobalConfig | null;
}

/** Pure precedence rule — the whole reason config resolution is testable. */
export function mergeConfig(sources: ConfigSources): ConfigFlags & {
  channel: string;
  deepLinkScheme?: string;
  publicKey?: string;
} {
  const { flags = {}, env = {}, project, global } = sources;
  const pick = <T>(...values: Array<T | undefined | null>): T | undefined => {
    for (const value of values) if (value !== undefined && value !== null && value !== "") return value;
    return undefined;
  };

  return {
    apiUrl: pick(flags.apiUrl, env.apiUrl, project?.apiUrl, global?.apiUrl),
    token: pick(flags.token, env.token, global?.token),
    projectId: pick(flags.projectId, env.projectId, project?.projectId),
    channel: pick(flags.channel, env.channel, project?.channel) ?? DEFAULT_CHANNEL,
    deepLinkScheme: project?.deepLinkScheme,
    publicKey: project?.publicKey,
  };
}

export function envConfig(env: NodeJS.ProcessEnv = process.env): ConfigFlags {
  return {
    apiUrl: env.OTA_API_URL,
    token: env.OTA_TOKEN,
    projectId: env.OTA_PROJECT_ID,
    channel: env.OTA_CHANNEL,
  };
}

/* ------------------------------------------------------------------- files */

export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "open-ota", "config.json");
}

export function loadGlobalConfig(env: NodeJS.ProcessEnv = process.env): GlobalConfig | null {
  return readJson<GlobalConfig>(globalConfigPath(env));
}

export function saveGlobalConfig(config: GlobalConfig, env: NodeJS.ProcessEnv = process.env): string {
  const path = globalConfigPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600); // writeFileSync does not lower the mode of an existing file
  return path;
}

/** Nearest ancestor with ota.config.json; else nearest with package.json; else cwd. */
export function findProjectRoot(cwd: string = process.cwd()): string {
  let dir = resolve(cwd);
  let packageRoot: string | null = null;
  for (;;) {
    if (existsSync(join(dir, PROJECT_CONFIG_FILE))) return dir;
    if (!packageRoot && existsSync(join(dir, "package.json"))) packageRoot = dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return packageRoot ?? resolve(cwd);
}

export function loadProjectConfig(projectRoot: string): ProjectConfig | null {
  return readJson<ProjectConfig>(join(projectRoot, PROJECT_CONFIG_FILE));
}

export function saveProjectConfig(projectRoot: string, config: ProjectConfig): string {
  const path = join(projectRoot, PROJECT_CONFIG_FILE);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}

export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    fail(`${path} is not valid JSON`, error instanceof Error ? error.message : undefined);
  }
}

/* ---------------------------------------------------------------- resolved */

export function resolveConfig(flags: ConfigFlags = {}, cwd: string = process.cwd()): ResolvedConfig {
  const projectRoot = findProjectRoot(cwd);
  const project = loadProjectConfig(projectRoot);
  const merged = mergeConfig({ flags, env: envConfig(), project, global: loadGlobalConfig() });
  return {
    ...merged,
    projectRoot,
    projectConfigPath: join(projectRoot, PROJECT_CONFIG_FILE),
    project,
  };
}

export function requireApi(config: ResolvedConfig): { apiUrl: string; token: string } {
  if (!config.apiUrl) {
    fail("No API url configured.", "Run `ota login`, or set OTA_API_URL.");
  }
  if (!config.token) {
    fail("No API token configured.", "Run `ota login`, or set OTA_TOKEN.");
  }
  return { apiUrl: config.apiUrl, token: config.token };
}

export function requireProjectId(config: ResolvedConfig): string {
  if (!config.projectId) {
    fail(
      `No project configured (looked for ${PROJECT_CONFIG_FILE} in ${config.projectRoot}).`,
      "Run `ota init`, or pass --project.",
    );
  }
  return config.projectId;
}
