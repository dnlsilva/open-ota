/**
 * The three-step publish (docs/API.md §3): prepare-upload → PUT the zip
 * straight to the signed storage url → confirm. The bundle never crosses the
 * API, which is what makes publishing work on edge runtimes.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  MAX_BUNDLE_BYTES,
  type OtaClient,
  type Platform,
  type PrepareUploadResponse,
  type Release,
} from "@open-ota/shared";

import { UserError } from "./output.js";
import { zipDirectory, type BundleArchive } from "./zip.js";

export interface PublishParams {
  client: OtaClient;
  projectId: string;
  platform: Platform;
  channel: string;
  runtimeVersion: string;
  archive: BundleArchive;
  rolloutPercent?: number;
  mandatory?: boolean;
  message?: string;
  gitCommit?: string;
  groupId?: string;
  /** Absolute base for a relative upload url, and the target when uploadViaServer. */
  apiUrl: string;
  token?: string;
  fetchImpl?: typeof globalThis.fetch;
}

export async function publishArchive(params: PublishParams): Promise<Release> {
  const { client, archive } = params;

  if (archive.bytes.length > MAX_BUNDLE_BYTES) {
    throw new UserError(
      `Bundle is ${archive.bytes.length} bytes, over the ${MAX_BUNDLE_BYTES} byte limit.`,
      "Trim assets, or raise the limit on your server.",
    );
  }

  const prepared = await client.prepareUpload(params.projectId, {
    sha256: archive.sha256,
    size: archive.bytes.length,
    platform: params.platform,
    channel: params.channel,
    runtimeVersion: params.runtimeVersion,
    rolloutPercent: params.rolloutPercent,
    mandatory: params.mandatory,
    message: params.message,
    gitCommit: params.gitCommit,
    groupId: params.groupId,
  });

  await uploadBundle(prepared, archive.bytes, params);

  const { release } = await client.confirmRelease(prepared.releaseId);
  return release;
}

export async function uploadBundle(
  prepared: PrepareUploadResponse,
  bytes: Uint8Array,
  params: Pick<PublishParams, "apiUrl" | "token" | "fetchImpl">,
): Promise<void> {
  const fetchImpl = params.fetchImpl ?? globalThis.fetch;
  const url = /^https?:\/\//i.test(prepared.uploadUrl)
    ? prepared.uploadUrl
    : `${params.apiUrl.replace(/\/+$/, "")}${prepared.uploadUrl.startsWith("/") ? "" : "/"}${prepared.uploadUrl}`;

  const headers: Record<string, string> = { ...prepared.uploadHeaders };
  if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
    headers["content-type"] = "application/zip";
  }
  // Only the server route is authenticated; a signed storage url carries its
  // own credentials in the query string and rejects a stray Authorization.
  if (prepared.uploadViaServer && params.token) headers.authorization = `Bearer ${params.token}`;

  const response = await fetchImpl(url, {
    method: prepared.uploadViaServer ? "POST" : "PUT",
    headers,
    body: bytes as unknown as BodyInit,
  });

  if (!response.ok) {
    throw new UserError(
      `Bundle upload failed with ${response.status} ${response.statusText}.`,
      "The signed url may have expired — run the publish again.",
    );
  }
}

export interface PublishDirParams extends Omit<PublishParams, "archive"> {
  bundleDir: string;
}

export async function publishBundleDir(params: PublishDirParams): Promise<{
  release: Release;
  archive: BundleArchive;
}> {
  const archive = await zipDirectory(params.bundleDir);
  const release = await publishArchive({ ...params, archive });
  return { release, archive };
}

/**
 * `--bundle-dir dist` accepts either a per-platform layout (`dist/ios`,
 * `dist/android`) or a single export directory used for every platform.
 */
export function bundleDirFor(bundleDir: string, platform: Platform): string {
  const nested = join(bundleDir, platform);
  return existsSync(nested) ? nested : bundleDir;
}
