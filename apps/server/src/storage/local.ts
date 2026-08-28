/**
 * Local disk, for `docker compose up` without MinIO and for tests. It cannot
 * sign URLs, so uploads and downloads route through the server — fine at that
 * scale, and the only driver where the server always re-verifies the digest.
 */

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { AppConfig } from "../config.js";
import type { StorageAdapter } from "./index.js";

export function createLocalStorage(config: AppConfig): StorageAdapter {
  const root = resolve(config.STORAGE_LOCAL_DIR);
  const pathFor = (key: string) => {
    const full = resolve(join(root, key));
    // A key is server-generated, but never let one escape the root anyway.
    if (!full.startsWith(root)) throw new Error("invalid storage key");
    return full;
  };

  return {
    name: "local",
    readsAreCheap: true,

    async createSignedUploadUrl(key) {
      return {
        url: `${config.publicUrl}/api/v1/storage/${encodeURIComponent(key)}`,
        headers: { "content-type": "application/zip" },
        viaServer: true,
      };
    },

    publicUrl(key) {
      const base = config.PUBLIC_BUNDLE_BASE_URL ?? `${config.publicUrl}/api/v1/storage`;
      return `${base.replace(/\/+$/, "")}/${encodeURIComponent(key)}`;
    },

    async head(key) {
      try {
        const s = await stat(pathFor(key));
        return { size: s.size };
      } catch {
        return null;
      }
    },

    async get(key) {
      try {
        return new Uint8Array(await readFile(pathFor(key)));
      } catch {
        return null;
      }
    },

    async put(key, body) {
      const path = pathFor(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
    },

    async delete(key) {
      await rm(pathFor(key), { force: true });
    },
  };
}
