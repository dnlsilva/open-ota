/** S3-compatible storage: Cloudflare R2, AWS S3, MinIO. */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { AppConfig } from "../config.js";
import type { StorageAdapter, UploadTarget } from "./index.js";

const UPLOAD_URL_TTL_SECONDS = 15 * 60;

export function createS3Storage(config: AppConfig): StorageAdapter {
  const client = new S3Client({
    region: config.STORAGE_REGION,
    endpoint: config.STORAGE_ENDPOINT,
    forcePathStyle: config.STORAGE_FORCE_PATH_STYLE,
    credentials:
      config.STORAGE_ACCESS_KEY && config.STORAGE_SECRET_KEY
        ? { accessKeyId: config.STORAGE_ACCESS_KEY, secretAccessKey: config.STORAGE_SECRET_KEY }
        : undefined,
  });
  const bucket = config.STORAGE_BUCKET;

  return {
    name: "s3",
    readsAreCheap: false,

    async createSignedUploadUrl(key, opts): Promise<UploadTarget> {
      const url = await getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          ContentType: opts.contentType,
          ContentLength: opts.size,
        }),
        { expiresIn: UPLOAD_URL_TTL_SECONDS },
      );
      return {
        url,
        headers: { "content-type": opts.contentType, "content-length": String(opts.size) },
      };
    },

    publicUrl(key) {
      if (config.PUBLIC_BUNDLE_BASE_URL) {
        return `${config.PUBLIC_BUNDLE_BASE_URL.replace(/\/+$/, "")}/${key}`;
      }
      const base = config.STORAGE_ENDPOINT?.replace(/\/+$/, "") ?? `https://s3.${config.STORAGE_REGION}.amazonaws.com`;
      return config.STORAGE_FORCE_PATH_STYLE ? `${base}/${bucket}/${key}` : `${base}/${key}`;
    },

    async head(key) {
      try {
        const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { size: Number(res.ContentLength ?? 0) };
      } catch {
        return null;
      }
    },

    async get(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const bytes = await res.Body?.transformToByteArray();
        return bytes ?? null;
      } catch {
        return null;
      }
    },

    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },

    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}
