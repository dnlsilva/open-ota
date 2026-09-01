/**
 * Telemetry that costs O(devices) + O(releases × days), never O(events).
 *
 * The update-check is already the heartbeat, so measuring active users needs
 * no extra request; each device is one row, written at most hourly, and the
 * funnel lives in daily counters. The only raw events kept are rollbacks —
 * rare, and the first thing anyone wants during an incident. docs/DATA-MODEL §4.
 */

import { DEVICE_TOUCH_THROTTLE_MS, uuidv7, type EventsRequest, type Platform } from "@open-ota/shared";
import { and, eq, inArray, or, ne, sql } from "drizzle-orm";
import { devices, releaseStats, releases, rollbackEvents } from "../db/schema.js";
import type { AppContext } from "./context.js";

export interface DeviceTouch {
  deviceId: string;
  projectId: string;
  platform: Platform;
  channel: string;
  nativeVersion?: string;
  runtimeVersion?: string;
  currentReleaseId?: string | null;
}

/**
 * Upsert that only writes when the row is stale or something actually changed.
 * At 100k devices opening the app a few times a day this keeps writes in the
 * tens per second instead of hundreds.
 */
export async function touchDevice(ctx: AppContext, touch: DeviceTouch): Promise<void> {
  const now = ctx.now();
  const staleBefore = new Date(now.getTime() - DEVICE_TOUCH_THROTTLE_MS);

  await ctx.db
    .insert(devices)
    .values({
      id: touch.deviceId,
      projectId: touch.projectId,
      platform: touch.platform,
      channel: touch.channel,
      nativeVersion: touch.nativeVersion ?? null,
      runtimeVersion: touch.runtimeVersion ?? null,
      currentReleaseId: touch.currentReleaseId ?? null,
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: devices.id,
      set: {
        lastSeenAt: now,
        channel: touch.channel,
        platform: touch.platform,
        nativeVersion: touch.nativeVersion ?? null,
        runtimeVersion: touch.runtimeVersion ?? null,
        currentReleaseId: touch.currentReleaseId ?? null,
      },
      where: or(
        sql`${devices.lastSeenAt} < ${staleBefore}`,
        sql`${devices.currentReleaseId} is distinct from ${touch.currentReleaseId ?? null}`,
        sql`${devices.nativeVersion} is distinct from ${touch.nativeVersion ?? null}`,
        sql`${devices.runtimeVersion} is distinct from ${touch.runtimeVersion ?? null}`,
        ne(devices.channel, touch.channel),
      ),
    });
}

const COUNTER_COLUMN = {
  download: "downloads",
  install: "installs",
  ready: "ready",
  verifyFailed: "failed",
  rollback: "rollbacks",
} as const satisfies Record<string, keyof typeof releaseStats.$inferInsert>;

export interface CounterRow {
  releaseId: string;
  day: string;
  downloads: number;
  installs: number;
  ready: number;
  failed: number;
  rollbacks: number;
}

export interface RollbackRecord {
  releaseId: string;
  fromReleaseId: string | null;
  reason: string;
  meta: Record<string, unknown>;
}

/**
 * Fold a batch into per-release daily increments, dropping anything that does
 * not belong to this project — an app key is public, so the release ids in a
 * batch are untrusted input.
 */
export function foldEvents(
  request: EventsRequest,
  ownedIds: ReadonlySet<string>,
  day: string,
): { counters: CounterRow[]; rollbacks: RollbackRecord[] } {
  const buckets = new Map<string, Record<string, number>>();
  const rollbacks: RollbackRecord[] = [];

  for (const event of request.events) {
    if (!ownedIds.has(event.release)) continue;

    const column = COUNTER_COLUMN[event.type as keyof typeof COUNTER_COLUMN];
    if (!column) continue;

    const bucket = buckets.get(event.release) ?? {};
    bucket[column] = (bucket[column] ?? 0) + 1;
    // A rollback is also a failed install of that release; counting it in both
    // places is what makes the funnel add up on the dashboard.
    if (event.type === "rollback") bucket.failed = (bucket.failed ?? 0) + 1;
    buckets.set(event.release, bucket);

    if (event.type === "rollback") {
      rollbacks.push({
        releaseId: event.release,
        fromReleaseId: event.meta?.from ?? null,
        reason: event.meta?.reason ?? "crash",
        meta: {
          platform: request.platform,
          nativeVersion: request.native,
          message: event.meta?.message,
          stage: event.meta?.stage,
        },
      });
    }
  }

  return {
    counters: [...buckets.entries()].map(([releaseId, counts]) => ({
      releaseId,
      day,
      downloads: counts.downloads ?? 0,
      installs: counts.installs ?? 0,
      ready: counts.ready ?? 0,
      failed: counts.failed ?? 0,
      rollbacks: counts.rollbacks ?? 0,
    })),
    rollbacks,
  };
}

/**
 * Fold a batch into per-release, per-day increments and apply them in one
 * statement. Counters are at-least-once: a retried batch may double count a
 * few units, which is the accepted trade for not storing an event log.
 */
export async function recordEvents(
  ctx: AppContext,
  projectId: string,
  request: EventsRequest,
): Promise<{ applied: number }> {
  const day = ctx.now().toISOString().slice(0, 10);

  // Only count events for releases that belong to this project — an app key is
  // public, so the release ids in a batch are not trusted input.
  const releaseIds = [...new Set(request.events.map((e) => e.release))];
  if (releaseIds.length === 0) return { applied: 0 };

  const owned = await ctx.db
    .select({ id: releases.id })
    .from(releases)
    .where(and(eq(releases.projectId, projectId), inArray(releases.id, releaseIds)));
  const ownedIds = new Set(owned.map((r) => r.id));

  const { counters: rows, rollbacks } = foldEvents(request, ownedIds, day);
  if (rows.length === 0) return { applied: 0 };

  await ctx.db
    .insert(releaseStats)
    .values(rows)
    .onConflictDoUpdate({
      target: [releaseStats.releaseId, releaseStats.day],
      set: {
        downloads: sql`${releaseStats.downloads} + excluded.downloads`,
        installs: sql`${releaseStats.installs} + excluded.installs`,
        ready: sql`${releaseStats.ready} + excluded.ready`,
        failed: sql`${releaseStats.failed} + excluded.failed`,
        rollbacks: sql`${releaseStats.rollbacks} + excluded.rollbacks`,
      },
    });

  if (rollbacks.length > 0) {
    await ctx.db.insert(rollbackEvents).values(
      rollbacks.map((r) => ({
        id: uuidv7(),
        projectId,
        releaseId: r.releaseId,
        fromReleaseId: r.fromReleaseId,
        deviceId: request.device,
        reason: r.reason,
        meta: r.meta as Record<string, unknown>,
      })),
    );
  }

  return { applied: rows.length };
}

/** Devices that have not checked in for a long time stop being interesting. */
export async function pruneDevices(ctx: AppContext, olderThanDays = 180): Promise<number> {
  const cutoff = new Date(ctx.now().getTime() - olderThanDays * 24 * 60 * 60 * 1000);
  const deleted = await ctx.db
    .delete(devices)
    .where(sql`${devices.lastSeenAt} < ${cutoff}`)
    .returning({ id: devices.id });
  return deleted.length;
}

/** Raw rollback rows earn their keep for a while, then become noise. */
export async function pruneRollbackEvents(ctx: AppContext, olderThanDays = 90): Promise<number> {
  const cutoff = new Date(ctx.now().getTime() - olderThanDays * 24 * 60 * 60 * 1000);
  const deleted = await ctx.db
    .delete(rollbackEvents)
    .where(sql`${rollbackEvents.createdAt} < ${cutoff}`)
    .returning({ id: rollbackEvents.id });
  return deleted.length;
}

/**
 * The retention DATA-MODEL §5 promises. The Node entry runs this daily; the
 * edge targets have no scheduler of their own yet, so a cron hitting any
 * always-on deployment covers the fleet — the data lives in one Postgres.
 */
export async function runMaintenance(ctx: AppContext): Promise<{ devices: number; rollbackEvents: number }> {
  return {
    devices: await pruneDevices(ctx),
    rollbackEvents: await pruneRollbackEvents(ctx),
  };
}
