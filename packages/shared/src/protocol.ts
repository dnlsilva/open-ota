/**
 * Wire protocol between the SDK and the Device API. Every shape here is
 * mirrored by the native SDKs — see docs/API.md §2.
 */

import { z } from "zod";

export const PLATFORMS = ["ios", "android"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const RELEASE_STATUSES = ["pending", "active", "paused", "disabled"] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];

/** Releases a device reports as broken. Capped so the query string stays sane. */
export const MAX_FAILED_RELEASES = 10;
export const MAX_BUNDLE_BYTES = 200 * 1024 * 1024;

/* ------------------------------------------------------------------ manifest */

/**
 * The signed part of an update. `url` is deliberately NOT in here: it is
 * transport, free to change with the CDN, while integrity comes from `sha256`
 * and authenticity from the detached signature.
 */
export const manifestSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string(),
  platform: z.enum(PLATFORMS),
  channel: z.string(),
  runtimeVersion: z.string(),
  label: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type Manifest = z.infer<typeof manifestSchema>;

/* -------------------------------------------------------------- update-check */

export const updateCheckQuerySchema = z.object({
  platform: z.enum(PLATFORMS),
  channel: z.string().min(1).max(64),
  runtime: z.string().min(1).max(128),
  device: z.string().min(8).max(64),
  /** Release currently running; absent means the embedded bundle. */
  current: z.string().uuid().optional(),
  /** Release id stamped into the binary at build time — never go below it. */
  floor: z.string().uuid().optional(),
  native: z.string().max(64).optional(),
  failed: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").filter(Boolean).slice(0, MAX_FAILED_RELEASES) : [])),
});
export type UpdateCheckQuery = z.infer<typeof updateCheckQuerySchema>;

export const UPDATE_ACTIONS = ["none", "update", "rollBackToEmbedded"] as const;
export type UpdateAction = (typeof UPDATE_ACTIONS)[number];

export const updateCheckResponseSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("none") }),
  z.object({ action: z.literal("rollBackToEmbedded") }),
  z.object({
    action: z.literal("update"),
    mandatory: z.boolean(),
    manifest: manifestSchema,
    signature: z.string(),
    url: z.string().url(),
  }),
]);
export type UpdateCheckResponse = z.infer<typeof updateCheckResponseSchema>;

/* -------------------------------------------------------------------- events */

export const EVENT_TYPES = ["download", "install", "ready", "rollback", "verifyFailed"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const ROLLBACK_REASONS = ["crash", "verifyFailed", "server", "manual"] as const;
export type RollbackReason = (typeof ROLLBACK_REASONS)[number];

export const deviceEventSchema = z.object({
  type: z.enum(EVENT_TYPES),
  release: z.string().uuid(),
  ts: z.number().int().nonnegative(),
  meta: z
    .object({
      reason: z.enum(ROLLBACK_REASONS).optional(),
      from: z.string().uuid().optional(),
      stage: z.string().max(64).optional(),
      message: z.string().max(512).optional(),
    })
    .optional(),
});
export type DeviceEvent = z.infer<typeof deviceEventSchema>;

export const eventsRequestSchema = z.object({
  device: z.string().min(8).max(64),
  platform: z.enum(PLATFORMS).optional(),
  channel: z.string().max(64).optional(),
  native: z.string().max(64).optional(),
  runtime: z.string().max(128).optional(),
  events: z.array(deviceEventSchema).min(1).max(50),
});
export type EventsRequest = z.infer<typeof eventsRequestSchema>;

/* ------------------------------------------------------------ preview tokens */

export const PREVIEW_PURPOSE = "preview" as const;
export const PREVIEW_DEFAULT_TTL_MINUTES = 15;
/** Devices may have a skewed clock; the server has none, so it validates strictly. */
export const PREVIEW_CLOCK_SKEW_SECONDS = 300;

export const previewTokenPayloadSchema = z.object({
  purpose: z.literal(PREVIEW_PURPOSE),
  projectId: z.string(),
  releaseId: z.string().uuid(),
  exp: z.number().int().positive(),
});
export type PreviewTokenPayload = z.infer<typeof previewTokenPayloadSchema>;

/* --------------------------------------------------------------------- misc */

export const APP_KEY_HEADER = "x-ota-app-key";
export const SDK_VERSION_HEADER = "x-ota-sdk-version";

/** Devices only get written when something changed or the row went stale. */
export const DEVICE_TOUCH_THROTTLE_MS = 60 * 60 * 1000;
