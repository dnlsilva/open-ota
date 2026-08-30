/**
 * Bundle passthrough for the `local` storage driver, which cannot sign URLs.
 * Every other driver hands the client a bucket URL and these routes stay dark.
 *
 * Public by design (app.ts): a bundle is immutable, hashed and signed, so the
 * download needs no secret. The upload does — a PUT is only accepted against a
 * release row that is still `pending`, which is what stops this becoming free
 * file hosting. See docs/API.md §3, publish steps ② and ③.
 */

import { MAX_BUNDLE_BYTES } from "@open-ota/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../app.js";
import { releases } from "../db/schema.js";
import type { AppContext } from "../services/context.js";
import { ApiError } from "../services/errors.js";
import type { StorageAdapter } from "../storage/index.js";

/** Exactly what bundleKey() builds. Nothing else can address an object. */
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const BUNDLE_KEY = new RegExp(`^bundles/${UUID}/${UUID}\\.zip$`, "i");

type LocalDriver = StorageAdapter & Required<Pick<StorageAdapter, "get" | "put">>;

export function storageRoutes() {
  const app = new Hono<AppEnv>();

  // `{.+}` so the key matches whether the client sent it percent-encoded as one
  // segment (what createSignedUploadUrl builds) or as raw path segments.
  app.put("/:key{.+}", async (c) => {
    const ctx = c.get("ctx");
    const driver = localDriver(ctx);
    const key = bundleKeyOf(c.req.param("key"));

    if (Number(c.req.header("content-length") ?? 0) > MAX_BUNDLE_BYTES) throw tooLarge();

    const release = await ctx.db.query.releases.findFirst({ where: eq(releases.storageKey, key) });
    if (!release) {
      throw ApiError.notFound("release_not_found", "No release is expecting an upload at that key");
    }
    if (release.status !== "pending") {
      throw ApiError.conflict("release_not_pending", "That release already has its bundle");
    }

    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.byteLength === 0) throw ApiError.badRequest("empty_upload", "The request body was empty");
    if (body.byteLength > MAX_BUNDLE_BYTES) throw tooLarge();

    await driver.put(key, body, "application/zip");
    return c.body(null, 201);
  });

  app.get("/:key{.+}", async (c) => {
    const ctx = c.get("ctx");
    const driver = localDriver(ctx);
    const key = bundleKeyOf(c.req.param("key"));

    const bytes = await driver.get(key);
    if (!bytes) throw ApiError.notFound("bundle_not_found", "No bundle at that key");

    // Uint8Array is not a Hono body type; the local driver always returns a
    // freshly allocated, zero-offset view, so its buffer is the whole object.
    return c.body(bytes.buffer as ArrayBuffer, 200, {
      "content-type": "application/zip",
      "content-length": String(bytes.byteLength),
      // The key carries the release id, so the bytes at a key never change.
      "cache-control": "public, max-age=31536000, immutable",
    });
  });

  return app;
}

function localDriver(ctx: AppContext): LocalDriver {
  const storage = ctx.storage;
  if (storage.name !== "local" || !storage.get || !storage.put) {
    throw ApiError.notFound(
      "storage_passthrough_disabled",
      "This deployment serves bundles straight from object storage",
    );
  }
  return storage as LocalDriver;
}

function bundleKeyOf(raw: string): string {
  // A valid key contains no '%' of its own, so decoding is safe either way —
  // and the pattern below is what actually keeps a key inside the bucket prefix.
  const key = raw.includes("%") ? safeDecode(raw) : raw;
  if (!BUNDLE_KEY.test(key)) throw ApiError.badRequest("invalid_key", "Not a bundle key");
  return key;
}

function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function tooLarge(): ApiError {
  return ApiError.badRequest("bundle_too_large", `A bundle may not exceed ${MAX_BUNDLE_BYTES} bytes`);
}
