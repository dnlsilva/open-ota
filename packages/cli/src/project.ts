/**
 * Reading and wiring the target app: Expo config plugin entry, bare RN
 * codemods, and the checks `ota doctor` needs.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { readJson } from "./config.js";

export const PLUGIN_PACKAGE = "@open-ota/react-native";

export interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

export type AppKind = "expo" | "bare" | "unknown";

export interface AppJson {
  expo?: {
    name?: string;
    slug?: string;
    scheme?: string | string[];
    plugins?: Array<string | [string, Record<string, unknown>?]>;
    updates?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export function readPackageJson(projectRoot: string): PackageJson | null {
  return readJson<PackageJson>(join(projectRoot, "package.json"));
}

export function dependencyNames(pkg: PackageJson | null): Set<string> {
  return new Set([...Object.keys(pkg?.dependencies ?? {}), ...Object.keys(pkg?.devDependencies ?? {})]);
}

export function appConfigPath(projectRoot: string): string | null {
  for (const name of ["app.json", "app.config.ts", "app.config.js", "app.config.mjs"]) {
    const path = join(projectRoot, name);
    if (existsSync(path)) return path;
  }
  return null;
}

export function detectAppKind(projectRoot: string): AppKind {
  const deps = dependencyNames(readPackageJson(projectRoot));
  if (deps.has("expo")) return "expo";

  const config = appConfigPath(projectRoot);
  // A bare RN template also ships app.json, but without an `expo` key.
  if (config && !config.endsWith("app.json")) return "expo";
  if (config?.endsWith("app.json") && readJson<AppJson>(config)?.expo) return "expo";

  if (existsSync(join(projectRoot, "android")) || existsSync(join(projectRoot, "ios"))) return "bare";
  if (deps.has("react-native")) return "bare";
  return "unknown";
}

export function hasExpoUpdates(projectRoot: string): boolean {
  if (dependencyNames(readPackageJson(projectRoot)).has("expo-updates")) return true;
  const config = appConfigPath(projectRoot);
  if (!config || !config.endsWith("app.json")) return false;
  const app = readJson<AppJson>(config);
  if (app?.expo?.updates) return true;
  return (app?.expo?.plugins ?? []).some((entry) =>
    (Array.isArray(entry) ? entry[0] : entry) === "expo-updates",
  );
}

/* ------------------------------------------------------------- expo plugin */

export interface PluginOptions extends Record<string, unknown> {
  projectId: string;
  apiUrl: string;
  channel: string;
  scheme?: string;
}

export type WireResult =
  | { kind: "written"; path: string }
  | { kind: "unchanged"; path: string }
  | { kind: "manual"; path: string; snippet: string };

/**
 * Adds (or refreshes) the `@open-ota/react-native` plugin entry in app.json.
 * A JS/TS app.config is not rewritten — evaluating and re-emitting user code is
 * a worse trade than printing the four lines to paste.
 */
export function wireExpoPlugin(projectRoot: string, options: PluginOptions): WireResult {
  const snippet = `["${PLUGIN_PACKAGE}", ${JSON.stringify(options, null, 2)}]`;
  const path = appConfigPath(projectRoot);

  if (!path || !path.endsWith("app.json")) {
    return { kind: "manual", path: path ?? join(projectRoot, "app.config.js"), snippet };
  }

  const app = (readJson<AppJson>(path) ?? {}) as AppJson;
  const expo = (app.expo ??= {});
  const plugins = (expo.plugins ??= []);
  const index = plugins.findIndex((entry) => (Array.isArray(entry) ? entry[0] : entry) === PLUGIN_PACKAGE);
  const entry: [string, Record<string, unknown>] = [PLUGIN_PACKAGE, options];

  const before = JSON.stringify(plugins);
  if (index >= 0) plugins[index] = entry;
  else plugins.push(entry);
  if (JSON.stringify(plugins) === before) return { kind: "unchanged", path };

  writeFileSync(path, `${JSON.stringify(app, null, 2)}\n`);
  return { kind: "written", path };
}

export function expoScheme(projectRoot: string): string | undefined {
  const path = appConfigPath(projectRoot);
  if (!path || !path.endsWith("app.json")) return undefined;
  const scheme = readJson<AppJson>(path)?.expo?.scheme;
  return Array.isArray(scheme) ? scheme[0] : scheme;
}

/* ----------------------------------------------------------- bare codemods */

export interface CodemodOptions {
  projectRoot: string;
  projectId: string;
  apiUrl: string;
  channel: string;
  scheme?: string;
  publicKey?: string;
}

export interface CodemodCheck {
  name: string;
  ok: boolean;
  message?: string;
}

export interface CodemodVerifyResult {
  ok: boolean;
  checks?: CodemodCheck[];
}

export interface Codemods {
  applyAndroid(options: CodemodOptions): Promise<unknown> | unknown;
  applyIos(options: CodemodOptions): Promise<unknown> | unknown;
  verify?(options: CodemodOptions): Promise<CodemodVerifyResult> | CodemodVerifyResult;
}

/**
 * The codemods ship with the SDK, which the CLI does not depend on — loaded
 * lazily from the target project so `ota publish` keeps working in a repo that
 * never installed it.
 */
export async function loadCodemods(projectRoot: string): Promise<Codemods | null> {
  const anchor = join(projectRoot, "package.json");
  const candidates: string[] = [];

  if (existsSync(anchor)) {
    try {
      candidates.push(createRequire(anchor).resolve(`${PLUGIN_PACKAGE}/plugin/codemods`));
    } catch {
      /* subpath not exported by the installed version — fall through */
    }
  }
  candidates.push(join(projectRoot, "node_modules", PLUGIN_PACKAGE, "plugin", "codemods.js"));

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const mod = (await import(pathToFileURL(candidate).href)) as { default?: Codemods } & Partial<Codemods>;
      const codemods = (mod.default ?? mod) as Codemods;
      if (typeof codemods.applyAndroid === "function") return codemods;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

export function readTextFile(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}
