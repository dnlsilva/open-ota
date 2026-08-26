/**
 * Storage seam. Bundles never pass through the API: the CLI hashes locally,
 * asks for a signed upload URL, PUTs straight to the bucket, then confirms —
 * which is what lets the same server run inside an edge function.
 */

import type { AppConfig } from "../config.js";

export interface UploadTarget {
  url: string;
  headers: Record<string, string>;
  /** Set when the driver cannot sign URLs and the client must post to us. */
  viaServer?: boolean;
}

export interface StorageAdapter {
  readonly name: string;
  createSignedUploadUrl(key: string, opts: { contentType: string; size: number }): Promise<UploadTarget>;
  /** URL handed to devices; the CDN origin when one is configured. */
  publicUrl(key: string): string;
  head(key: string): Promise<{ size: number } | null>;
  /** Only implemented where re-reading is cheap; used to re-verify digests. */
  get?(key: string): Promise<Uint8Array | null>;
  put?(key: string, body: Uint8Array, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export function bundleKey(projectId: string, releaseId: string): string {
  return `bundles/${projectId}/${releaseId}.zip`;
}

export async function createStorage(config: AppConfig): Promise<StorageAdapter> {
  switch (config.STORAGE_DRIVER) {
    case "supabase": {
      const { createSupabaseStorage } = await import("./supabase.js");
      return createSupabaseStorage(config);
    }
    case "local": {
      const { createLocalStorage } = await import("./local.js");
      return createLocalStorage(config);
    }
    case "s3":
    default: {
      const { createS3Storage } = await import("./s3.js");
      return createS3Storage(config);
    }
  }
}
