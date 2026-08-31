/**
 * Release lifecycle and the update-check decision.
 *
 * The server answers "which release should this device be on", and the SDK
 * converges on it — upwards for an update, downwards when the running release
 * was disabled, or back to the embedded bundle. One mechanism covers update,
 * downgrade and remote rollback. See docs/API.md §2.1.
 */

import {
  decryptSecret,
  isInRollout,
  isNewerRelease,
  signCanonical,
  uuidv7,
  MAX_BUNDLE_BYTES,
  type Manifest,
  type Platform,
  type ReleaseStatus,
  type UpdateCheckQuery,
  type UpdateCheckResponse,
} from "@open-ota/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { channels, projects, releases, type ReleaseRow } from "../db/schema.js";
import type { AppContext } from "./context.js";
import { ApiError } from "./errors.js";
import { bundleKey } from "../storage/index.js";

import type { ProjectRow } from "../db/schema.js";

/** The full project row — the private key rides along so signing is one lookup. */
export type ResolvedProject = ProjectRow;

/* ----------------------------------------------------------- update-check */

export async function resolveUpdate(
  ctx: AppContext,
  project: ResolvedProject,
  query: UpdateCheckQuery,
): Promise<UpdateCheckResponse> {
  const channel = await ctx.db.query.channels.findFirst({
    where: and(eq(channels.projectId, project.id), eq(channels.name, query.channel)),
  });
  // An unknown channel is not an error for a device in the field — it simply
  // has nothing to install.
  if (!channel) return { action: "none" };

  const rows = await ctx.db
    .select()
    .from(releases)
    .where(
      and(
        eq(releases.projectId, project.id),
        eq(releases.channelId, channel.id),
        eq(releases.platform, query.platform),
        eq(releases.runtimeVersion, query.runtime),
        inArray(releases.status, ["active", "paused"]),
      ),
    )
    .orderBy(desc(releases.id));

  const decision = await decideTarget(rows, query);
  if (decision.action !== "update") return decision;

  const manifest = toManifest(decision.target, project.id, query.channel);
  const privateKeyPem = await decryptSecret(project.privateKeyEnc, ctx.config.OTA_MASTER_KEY);
  const signature = await signCanonical(manifest as never, privateKeyPem);

  return {
    action: "update",
    mandatory: decision.target.mandatory,
    manifest,
    signature,
    url: ctx.storage.publicUrl(decision.target.storageKey),
  };
}

/** Just enough of a release row to decide. Keeps the decision testable. */
export interface CandidateRelease {
  id: string;
  status: string;
  rolloutPercent: number;
  mandatory: boolean;
  storageKey: string;
}

export type TargetDecision<T extends CandidateRelease> =
  | { action: "none" }
  | { action: "rollBackToEmbedded" }
  | { action: "update"; target: T };

/**
 * The whole update-check policy, with no database in the way.
 *
 * `rows` must already be filtered to this project+channel+platform+runtime and
 * to statuses active|paused, ordered newest id first.
 */
export async function decideTarget<T extends CandidateRelease>(
  rows: T[],
  query: Pick<UpdateCheckQuery, "device" | "current" | "floor" | "failed">,
): Promise<TargetDecision<T>> {
  const failed = new Set(query.failed);
  // "Still runnable" is stricter than "still exists": a device that reported
  // the release it is on as failed must not be told to stay on it, or it sits
  // in a crash loop while the server answers `none`.
  const current =
    query.current && !failed.has(query.current)
      ? rows.find((r) => r.id === query.current && isNewerRelease(r.id, query.floor ?? null))
      : undefined;

  let target: T | undefined;
  for (const row of rows) {
    if (failed.has(row.id)) continue;
    // Never hand a device a bundle older than the JS baked into its binary.
    if (!isNewerRelease(row.id, query.floor ?? null)) continue;

    // Sticky: a device already on a release keeps it even once the rollout is
    // paused. Only `disabled` pulls devices off a release they already run.
    if (row.id === query.current) {
      target = row;
      break;
    }
    if (row.status !== "active") continue;
    if (!(await isInRollout(query.device, row.id, row.rolloutPercent))) continue;

    target = row;
    break;
  }

  if (!target) {
    // Nothing qualifies. A device running something that no longer qualifies
    // goes back to the bundle inside its binary; one already on the embedded
    // bundle simply stays put.
    if (current) return { action: "none" };
    return query.current ? { action: "rollBackToEmbedded" } : { action: "none" };
  }

  if (target.id === query.current) return { action: "none" };
  return { action: "update", target };
}

export function toManifest(row: ReleaseRow, projectId: string, channelName: string): Manifest {
  return {
    id: row.id,
    projectId,
    platform: row.platform as Platform,
    channel: channelName,
    runtimeVersion: row.runtimeVersion,
    label: row.label,
    sha256: row.sha256,
    size: row.size,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function signManifest(
  ctx: AppContext,
  project: { privateKeyEnc: string },
  manifest: Manifest,
): Promise<string> {
  const privateKeyPem = await decryptSecret(project.privateKeyEnc, ctx.config.OTA_MASTER_KEY);
  return signCanonical(manifest as never, privateKeyPem);
}

/* --------------------------------------------------------------- publish */

export interface PrepareUploadInput {
  projectId: string;
  platform: Platform;
  channel: string;
  runtimeVersion: string;
  sha256: string;
  size: number;
  rolloutPercent?: number;
  mandatory?: boolean;
  message?: string;
  gitCommit?: string;
  groupId?: string;
  createdBy?: string;
}

export async function prepareUpload(ctx: AppContext, input: PrepareUploadInput) {
  if (input.size <= 0 || input.size > MAX_BUNDLE_BYTES) {
    throw ApiError.badRequest("bundle_too_large", `Bundle must be between 1 byte and ${MAX_BUNDLE_BYTES} bytes`);
  }
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) {
    throw ApiError.badRequest("invalid_digest", "sha256 must be 64 lowercase hex characters");
  }

  const channel = await ensureChannel(ctx, input.projectId, input.channel);
  const releaseId = uuidv7();
  const key = bundleKey(input.projectId, releaseId);
  const label = await nextLabel(ctx, input.projectId, channel.id, input.platform);

  await ctx.db.insert(releases).values({
    id: releaseId,
    projectId: input.projectId,
    channelId: channel.id,
    platform: input.platform,
    label,
    groupId: input.groupId ?? null,
    runtimeVersion: input.runtimeVersion,
    // Not offered to anyone until the upload is confirmed.
    status: "pending",
    mandatory: input.mandatory ?? false,
    rolloutPercent: clampRollout(input.rolloutPercent ?? 100),
    storageKey: key,
    size: input.size,
    sha256: input.sha256,
    message: input.message ?? null,
    gitCommit: input.gitCommit ?? null,
    createdBy: input.createdBy ?? null,
  });

  const target = await ctx.storage.createSignedUploadUrl(key, {
    contentType: "application/zip",
    size: input.size,
  });

  return {
    releaseId,
    label,
    uploadUrl: target.url,
    uploadHeaders: target.headers,
    storageKey: key,
    uploadViaServer: target.viaServer ?? false,
  };
}

/**
 * Step three of publish: the bytes are in the bucket, so verify what landed,
 * sign the manifest and let devices have it.
 */
export async function confirmRelease(ctx: AppContext, releaseId: string): Promise<ReleaseRow> {
  const row = await getRelease(ctx, releaseId);
  if (row.status !== "pending") return row;

  const head = await ctx.storage.head(row.storageKey);
  if (!head) {
    throw ApiError.badRequest("upload_missing", "No object found at the upload location");
  }
  if (head.size !== row.size) {
    await ctx.storage.delete(row.storageKey).catch(() => {});
    throw ApiError.badRequest(
      "size_mismatch",
      `Uploaded object is ${head.size} bytes, expected ${row.size}`,
    );
  }

  // Where re-reading is cheap, confirm the digest rather than taking the
  // publisher's word for it.
  if (ctx.storage.readsAreCheap && ctx.storage.get) {
    const bytes = await ctx.storage.get(row.storageKey);
    if (bytes) {
      const { sha256Hex } = await import("@open-ota/shared");
      const actual = await sha256Hex(bytes);
      if (actual !== row.sha256) {
        await ctx.storage.delete(row.storageKey).catch(() => {});
        throw ApiError.badRequest("digest_mismatch", "Uploaded bundle does not match the declared sha256");
      }
    }
  }

  const project = await requireProject(ctx, row.projectId);
  const channel = await ctx.db.query.channels.findFirst({ where: eq(channels.id, row.channelId) });
  const manifest = toManifest(row, row.projectId, channel?.name ?? "");
  const signature = await signManifest(ctx, project, manifest);

  const [updated] = await ctx.db
    .update(releases)
    .set({ status: "active", signature })
    .where(eq(releases.id, releaseId))
    .returning();

  return updated!;
}

/* ------------------------------------------------------------- operations */

export async function updateRelease(
  ctx: AppContext,
  releaseId: string,
  patch: { status?: ReleaseStatus; rolloutPercent?: number; mandatory?: boolean; message?: string },
): Promise<ReleaseRow> {
  const row = await getRelease(ctx, releaseId);
  if (row.status === "pending" && patch.status && patch.status !== "disabled") {
    throw ApiError.conflict("release_not_confirmed", "This release has no confirmed bundle yet");
  }

  const [updated] = await ctx.db
    .update(releases)
    .set({
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.rolloutPercent !== undefined ? { rolloutPercent: clampRollout(patch.rolloutPercent) } : {}),
      ...(patch.mandatory !== undefined ? { mandatory: patch.mandatory } : {}),
      ...(patch.message !== undefined ? { message: patch.message } : {}),
    })
    .where(eq(releases.id, releaseId))
    .returning();

  return updated!;
}

/**
 * Promote copies the release into the destination channel: a new row, new id
 * and label, same bundle. Each channel keeps a complete, immutable history
 * instead of a pointer that moves.
 */
export async function promoteRelease(
  ctx: AppContext,
  releaseId: string,
  channelName: string,
  rolloutPercent?: number,
): Promise<ReleaseRow> {
  const source = await getRelease(ctx, releaseId);
  const channel = await ensureChannel(ctx, source.projectId, channelName);
  if (channel.id === source.channelId) {
    throw ApiError.conflict("same_channel", "That release is already in this channel");
  }

  const project = await requireProject(ctx, source.projectId);
  const newId = uuidv7();
  const label = await nextLabel(ctx, source.projectId, channel.id, source.platform as Platform);

  const manifest: Manifest = {
    id: newId,
    projectId: source.projectId,
    platform: source.platform as Platform,
    channel: channelName,
    runtimeVersion: source.runtimeVersion,
    label,
    sha256: source.sha256,
    size: source.size,
    createdAt: ctx.now().toISOString(),
  };
  const signature = await signManifest(ctx, project, manifest);

  const [row] = await ctx.db
    .insert(releases)
    .values({
      id: newId,
      projectId: source.projectId,
      channelId: channel.id,
      platform: source.platform,
      label,
      groupId: source.groupId,
      runtimeVersion: source.runtimeVersion,
      status: "active",
      mandatory: source.mandatory,
      rolloutPercent: clampRollout(rolloutPercent ?? 100),
      // Same object: promoting must not re-upload or re-hash anything.
      storageKey: source.storageKey,
      size: source.size,
      sha256: source.sha256,
      signature,
      message: source.message,
      gitCommit: source.gitCommit,
      createdAt: new Date(manifest.createdAt),
    })
    .returning();

  return row!;
}

/**
 * Disable a release and report where its devices will land, so the caller can
 * say "rolling back to v41" instead of just "disabled".
 */
export async function rollbackRelease(ctx: AppContext, releaseId: string) {
  const row = await getRelease(ctx, releaseId);
  const disabled = await updateRelease(ctx, releaseId, { status: "disabled" });

  const [target] = await ctx.db
    .select()
    .from(releases)
    .where(
      and(
        eq(releases.projectId, row.projectId),
        eq(releases.channelId, row.channelId),
        eq(releases.platform, row.platform),
        eq(releases.runtimeVersion, row.runtimeVersion),
        eq(releases.status, "active"),
      ),
    )
    .orderBy(desc(releases.id))
    .limit(1);

  return { release: disabled, target: target ?? null };
}

/* ----------------------------------------------------------------- lookup */

export async function getRelease(ctx: AppContext, releaseId: string): Promise<ReleaseRow> {
  const row = await ctx.db.query.releases.findFirst({ where: eq(releases.id, releaseId) });
  if (!row) throw ApiError.notFound("release_not_found", "No release with that id");
  return row;
}

/** Accepts a uuid or a "v42"/"42" label, which is what people actually type. */
export async function findRelease(
  ctx: AppContext,
  projectId: string,
  ref: string,
  scope: { channel?: string; platform?: Platform } = {},
): Promise<ReleaseRow> {
  if (/^[0-9a-f-]{36}$/i.test(ref)) {
    const row = await getRelease(ctx, ref);
    if (row.projectId !== projectId) throw ApiError.notFound("release_not_found", "No release with that id");
    return row;
  }

  const label = Number(ref.replace(/^v/i, ""));
  if (!Number.isInteger(label)) {
    throw ApiError.badRequest("invalid_release_ref", `Cannot read "${ref}" as a release id or label`);
  }

  const conditions = [eq(releases.projectId, projectId), eq(releases.label, label)];
  if (scope.platform) conditions.push(eq(releases.platform, scope.platform));
  if (scope.channel) {
    const channel = await ctx.db.query.channels.findFirst({
      where: and(eq(channels.projectId, projectId), eq(channels.name, scope.channel)),
    });
    if (channel) conditions.push(eq(releases.channelId, channel.id));
  }

  const rows = await ctx.db.select().from(releases).where(and(...conditions)).orderBy(desc(releases.id));
  if (rows.length === 0) throw ApiError.notFound("release_not_found", `No release labelled v${label}`);
  if (rows.length > 1 && !scope.platform) {
    throw ApiError.badRequest(
      "ambiguous_release",
      `v${label} exists on more than one platform or channel — pass --platform or use the release id`,
      { candidates: rows.map((r) => ({ id: r.id, platform: r.platform })) },
    );
  }
  return rows[0]!;
}

export async function requireProject(ctx: AppContext, projectId: string): Promise<ResolvedProject> {
  const row = await ctx.db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!row) throw ApiError.notFound("project_not_found", "No project with that id");
  return row;
}

export async function ensureChannel(ctx: AppContext, projectId: string, name: string) {
  const existing = await ctx.db.query.channels.findFirst({
    where: and(eq(channels.projectId, projectId), eq(channels.name, name)),
  });
  if (existing) return existing;

  const [created] = await ctx.db
    .insert(channels)
    .values({ id: uuidv7(), projectId, name })
    .onConflictDoNothing()
    .returning();
  if (created) return created;

  const row = await ctx.db.query.channels.findFirst({
    where: and(eq(channels.projectId, projectId), eq(channels.name, name)),
  });
  if (!row) throw ApiError.conflict("channel_failed", "Could not create the channel");
  return row;
}

/**
 * Labels are per project+channel+platform and must not collide when two
 * publishes race, so the next value is computed inside the statement.
 */
async function nextLabel(
  ctx: AppContext,
  projectId: string,
  channelId: string,
  platform: Platform,
): Promise<number> {
  const [row] = await ctx.db
    .select({ next: sql<number>`coalesce(max(${releases.label}), 0) + 1` })
    .from(releases)
    .where(
      and(
        eq(releases.projectId, projectId),
        eq(releases.channelId, channelId),
        eq(releases.platform, platform),
      ),
    );
  return Number(row?.next ?? 1);
}

function clampRollout(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
