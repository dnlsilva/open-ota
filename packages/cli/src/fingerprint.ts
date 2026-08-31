/**
 * runtimeVersion = fingerprint of the native project (ARCHITECTURE §5).
 *
 * `@expo/fingerprint` is resolved from the TARGET project, never from the CLI:
 * the hash must reflect that project's own dependency graph and fingerprint
 * version, and pinning our copy would silently produce a different hash than
 * the app's own tooling.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { FINGERPRINT_FILE, readJson } from "./config.js";
import { fail } from "./output.js";

export const RUNTIME_VERSION_PREFIX = "fp_";

export interface FingerprintFile {
  /** Value stamped on releases and embedded in the binary. */
  runtimeVersion: string;
  hash: string;
  generatedAt: string;
  sources?: number;
}

interface ExpoFingerprintModule {
  createFingerprintAsync(
    projectRoot: string,
    options?: unknown,
  ): Promise<{ hash: string; sources?: unknown[] }>;
}

export function fingerprintPath(projectRoot: string): string {
  return join(projectRoot, FINGERPRINT_FILE);
}

export function readFingerprint(projectRoot: string): FingerprintFile | null {
  return readJson<FingerprintFile>(fingerprintPath(projectRoot));
}

export function runtimeVersionOf(hash: string): string {
  return hash.startsWith(RUNTIME_VERSION_PREFIX) ? hash : `${RUNTIME_VERSION_PREFIX}${hash}`;
}

/** Loads @expo/fingerprint out of the project's node_modules, or null. */
export async function loadFingerprintModule(projectRoot: string): Promise<ExpoFingerprintModule | null> {
  const anchor = join(projectRoot, "package.json");
  if (!existsSync(anchor)) return null;
  try {
    const resolved = createRequire(anchor).resolve("@expo/fingerprint");
    return (await import(pathToFileURL(resolved).href)) as ExpoFingerprintModule;
  } catch {
    return null;
  }
}

export async function computeFingerprint(projectRoot: string): Promise<FingerprintFile> {
  const fingerprint = await loadFingerprintModule(projectRoot);
  if (!fingerprint) {
    fail(
      "`@expo/fingerprint` is not installed in this project.",
      "Install it (`npx expo install @expo/fingerprint`) — it is what makes an OTA update refuse to land on an incompatible binary.",
    );
  }

  const result = await fingerprint.createFingerprintAsync(projectRoot);
  return {
    runtimeVersion: runtimeVersionOf(result.hash),
    hash: result.hash,
    generatedAt: new Date().toISOString(),
    sources: result.sources?.length,
  };
}

/**
 * The runtime version a publish should stamp: the committed fingerprint.json,
 * which the binary also embeds. Recomputing here instead would happily publish
 * against a fingerprint no installed app has.
 */
export function requireRuntimeVersion(projectRoot: string): string {
  const file = readFingerprint(projectRoot);
  if (!file?.runtimeVersion) {
    fail(
      `No ${FINGERPRINT_FILE} in ${projectRoot}.`,
      "Run `ota fingerprint` and commit the result — it is the contract between this bundle and the installed binary.",
    );
  }
  return file.runtimeVersion;
}
