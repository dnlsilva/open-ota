/**
 * Supabase Storage over its REST API — no SDK needed, and it works unchanged
 * inside a Supabase Edge Function.
 */

import type { AppConfig } from "../config.js";
import type { StorageAdapter } from "./index.js";

export function createSupabaseStorage(config: AppConfig): StorageAdapter {
  const base = config.SUPABASE_URL?.replace(/\/+$/, "");
  const key = config.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) {
    throw new Error("STORAGE_DRIVER=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  }
  const bucket = config.STORAGE_BUCKET;
  const auth = { authorization: `Bearer ${key}`, apikey: key };

  return {
    name: "supabase",
    readsAreCheap: false,

    async createSignedUploadUrl(objectKey, opts) {
      const res = await fetch(`${base}/storage/v1/object/upload/sign/${bucket}/${objectKey}`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ expiresIn: 900 }),
      });
      if (!res.ok) throw new Error(`Supabase signed upload failed: ${res.status} ${await res.text()}`);
      const body = (await res.json()) as { url: string };
      return {
        url: `${base}/storage/v1${body.url}`,
        headers: { "content-type": opts.contentType },
      };
    },

    publicUrl(objectKey) {
      if (config.PUBLIC_BUNDLE_BASE_URL) {
        return `${config.PUBLIC_BUNDLE_BASE_URL.replace(/\/+$/, "")}/${objectKey}`;
      }
      return `${base}/storage/v1/object/public/${bucket}/${objectKey}`;
    },

    async head(objectKey) {
      const res = await fetch(`${base}/storage/v1/object/info/${bucket}/${objectKey}`, {
        headers: auth,
      });
      if (!res.ok) return null;
      const info = (await res.json()) as { size?: number; contentLength?: number };
      return { size: Number(info.size ?? info.contentLength ?? 0) };
    },

    async get(objectKey) {
      const res = await fetch(`${base}/storage/v1/object/${bucket}/${objectKey}`, { headers: auth });
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    },

    async put(objectKey, body, contentType) {
      const res = await fetch(`${base}/storage/v1/object/${bucket}/${objectKey}`, {
        method: "POST",
        headers: { ...auth, "content-type": contentType, "x-upsert": "true" },
        body,
      });
      if (!res.ok) throw new Error(`Supabase upload failed: ${res.status}`);
    },

    async delete(objectKey) {
      await fetch(`${base}/storage/v1/object/${bucket}/${objectKey}`, {
        method: "DELETE",
        headers: auth,
      });
    },
  };
}
