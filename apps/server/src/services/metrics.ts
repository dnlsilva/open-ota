/**
 * Dashboard reads. Everything here comes from the two cheap sources: one row
 * per device, and daily counters per release. "Active" always means seen
 * inside the window, and the window is shown in the UI rather than implied.
 */

import type {
  ChannelHealth,
  NativeVersionRow,
  Platform,
  ProjectOverview,
  Release,
  ReleaseMetrics,
  RollbackEvent,
  VersionDistributionRow,
} from "@open-ota/shared";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { channels, devices, releaseStats, releases, rollbackEvents } from "../db/schema.js";
import type { AppContext } from "./context.js";
import { getRelease, requireProject } from "./releases.js";

export const DEFAULT_WINDOW_DAYS = 30;

function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function windowStart(ctx: AppContext, days: number): Date {
  return new Date(ctx.now().getTime() - days * 24 * 60 * 60 * 1000);
}

export async function getReleaseMetrics(
  ctx: AppContext,
  releaseId: string,
  days = 14,
): Promise<ReleaseMetrics> {
  const release = await getRelease(ctx, releaseId);
  const since = windowStart(ctx, days).toISOString().slice(0, 10);

  const daily = await ctx.db
    .select()
    .from(releaseStats)
    .where(and(eq(releaseStats.releaseId, releaseId), gte(releaseStats.day, since)))
    .orderBy(releaseStats.day);

  const [totals] = await ctx.db
    .select({
      downloads: sql<number>`coalesce(sum(${releaseStats.downloads}), 0)::int`,
      installs: sql<number>`coalesce(sum(${releaseStats.installs}), 0)::int`,
      ready: sql<number>`coalesce(sum(${releaseStats.ready}), 0)::int`,
      failed: sql<number>`coalesce(sum(${releaseStats.failed}), 0)::int`,
      rollbacks: sql<number>`coalesce(sum(${releaseStats.rollbacks}), 0)::int`,
    })
    .from(releaseStats)
    .where(eq(releaseStats.releaseId, releaseId));

  const [active] = await ctx.db
    .select({ count: sql<number>`count(*)::int` })
    .from(devices)
    .where(
      and(
        eq(devices.currentReleaseId, releaseId),
        gte(devices.lastSeenAt, windowStart(ctx, DEFAULT_WINDOW_DAYS)),
      ),
    );

  const sums = totals ?? { downloads: 0, installs: 0, ready: 0, failed: 0, rollbacks: 0 };

  return {
    releaseId,
    label: release.label,
    activeDevices: active?.count ?? 0,
    ...sums,
    successRate: ratio(sums.ready, sums.installs),
    rollbackRate: ratio(sums.rollbacks, sums.installs),
    daily: daily.map((d) => ({
      day: typeof d.day === "string" ? d.day : String(d.day),
      downloads: d.downloads,
      installs: d.installs,
      ready: d.ready,
      failed: d.failed,
      rollbacks: d.rollbacks,
    })),
  };
}

export async function getDistribution(
  ctx: AppContext,
  projectId: string,
  opts: { platform?: Platform; windowDays?: number } = {},
): Promise<{
  releases: VersionDistributionRow[];
  nativeVersions: NativeVersionRow[];
  totalDevices: number;
}> {
  const since = windowStart(ctx, opts.windowDays ?? DEFAULT_WINDOW_DAYS);
  // Built with the query builder rather than raw SQL: db.execute() hands back
  // a different shape on each driver (rows array vs result object), and this
  // server has to run on more than one.
  const scope = opts.platform
    ? and(eq(devices.projectId, projectId), gte(devices.lastSeenAt, since), eq(devices.platform, opts.platform))
    : and(eq(devices.projectId, projectId), gte(devices.lastSeenAt, since));

  const releaseRows = await ctx.db
    .select({
      releaseId: devices.currentReleaseId,
      label: releases.label,
      platform: devices.platform,
      count: sql<number>`count(*)::int`,
    })
    .from(devices)
    .leftJoin(releases, eq(releases.id, devices.currentReleaseId))
    .where(scope)
    .groupBy(devices.currentReleaseId, releases.label, devices.platform)
    .orderBy(desc(sql`count(*)`));

  const nativeRows = await ctx.db
    .select({
      nativeVersion: devices.nativeVersion,
      platform: devices.platform,
      count: sql<number>`count(*)::int`,
    })
    .from(devices)
    .where(scope)
    .groupBy(devices.nativeVersion, devices.platform)
    .orderBy(desc(sql`count(*)`));

  const knownIds = releaseRows.map((r) => r.releaseId).filter((id): id is string => id !== null);
  const statRows = knownIds.length
    ? await ctx.db
        .select({
          releaseId: releaseStats.releaseId,
          installs: sql<number>`coalesce(sum(${releaseStats.installs}), 0)::int`,
          rollbacks: sql<number>`coalesce(sum(${releaseStats.rollbacks}), 0)::int`,
        })
        .from(releaseStats)
        .where(inArray(releaseStats.releaseId, knownIds))
        .groupBy(releaseStats.releaseId)
    : [];
  const stats = new Map(statRows.map((s) => [s.releaseId, s]));

  const total = releaseRows.reduce((sum, row) => sum + Number(row.count), 0);
  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);

  return {
    totalDevices: total,
    releases: releaseRows.map((row) => ({
      releaseId: row.releaseId,
      label: row.label ?? null,
      platform: row.platform as Platform,
      devices: Number(row.count),
      percentOfBase: pct(Number(row.count)),
      installs: Number(stats.get(row.releaseId ?? "")?.installs ?? 0),
      rollbacks: Number(stats.get(row.releaseId ?? "")?.rollbacks ?? 0),
    })),
    nativeVersions: nativeRows.map((row) => ({
      nativeVersion: row.nativeVersion ?? "unknown",
      platform: row.platform as Platform,
      devices: Number(row.count),
      percentOfBase: pct(Number(row.count)),
    })),
  };
}

export async function listRollbacks(
  ctx: AppContext,
  projectId: string,
  limit = 50,
): Promise<RollbackEvent[]> {
  const rows = await ctx.db
    .select({
      id: rollbackEvents.id,
      releaseId: rollbackEvents.releaseId,
      fromReleaseId: rollbackEvents.fromReleaseId,
      deviceId: rollbackEvents.deviceId,
      reason: rollbackEvents.reason,
      meta: rollbackEvents.meta,
      createdAt: rollbackEvents.createdAt,
      label: releases.label,
      platform: releases.platform,
    })
    .from(rollbackEvents)
    .leftJoin(releases, eq(releases.id, rollbackEvents.releaseId))
    .where(eq(rollbackEvents.projectId, projectId))
    .orderBy(desc(rollbackEvents.createdAt))
    .limit(Math.min(limit, 200));

  return rows.map((row) => ({
    id: row.id,
    releaseId: row.releaseId,
    releaseLabel: row.label ?? null,
    fromReleaseId: row.fromReleaseId,
    deviceId: row.deviceId,
    reason: row.reason as RollbackEvent["reason"],
    platform: (row.platform as Platform) ?? null,
    nativeVersion: (row.meta?.nativeVersion as string) ?? null,
    message: (row.meta?.message as string) ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function getProjectOverview(ctx: AppContext, projectId: string): Promise<ProjectOverview> {
  const project = await requireProject(ctx, projectId);
  const since = windowStart(ctx, DEFAULT_WINDOW_DAYS);

  const [totalRow] = await ctx.db
    .select({ count: sql<number>`count(*)::int` })
    .from(devices)
    .where(and(eq(devices.projectId, projectId), gte(devices.lastSeenAt, since)));
  const totalActiveDevices = totalRow?.count ?? 0;

  const projectChannels = await ctx.db
    .select()
    .from(channels)
    .where(eq(channels.projectId, projectId))
    .orderBy(channels.name);

  const health: ChannelHealth[] = [];
  for (const channel of projectChannels) {
    for (const platform of ["ios", "android"] as const) {
      const [current] = await ctx.db
        .select()
        .from(releases)
        .where(
          and(
            eq(releases.projectId, projectId),
            eq(releases.channelId, channel.id),
            eq(releases.platform, platform),
            eq(releases.status, "active"),
          ),
        )
        .orderBy(desc(releases.id))
        .limit(1);

      if (!current) continue;

      const [devicesOnIt] = await ctx.db
        .select({ count: sql<number>`count(*)::int` })
        .from(devices)
        .where(
          and(
            eq(devices.projectId, projectId),
            eq(devices.currentReleaseId, current.id),
            gte(devices.lastSeenAt, since),
          ),
        );

      const [platformTotal] = await ctx.db
        .select({ count: sql<number>`count(*)::int` })
        .from(devices)
        .where(
          and(
            eq(devices.projectId, projectId),
            eq(devices.platform, platform),
            eq(devices.channel, channel.name),
            gte(devices.lastSeenAt, since),
          ),
        );

      const [stats] = await ctx.db
        .select({
          installs: sql<number>`coalesce(sum(${releaseStats.installs}), 0)::int`,
          ready: sql<number>`coalesce(sum(${releaseStats.ready}), 0)::int`,
          rollbacks: sql<number>`coalesce(sum(${releaseStats.rollbacks}), 0)::int`,
        })
        .from(releaseStats)
        .where(eq(releaseStats.releaseId, current.id));

      health.push({
        channel: channel.name,
        platform,
        currentRelease: toReleaseDto(current, channel.name),
        activeDevices: devicesOnIt?.count ?? 0,
        adoptionPercent: ratio(devicesOnIt?.count ?? 0, platformTotal?.count ?? 0),
        successRate: ratio(stats?.ready ?? 0, stats?.installs ?? 0),
        rollbackRate: ratio(stats?.rollbacks ?? 0, stats?.installs ?? 0),
      });
    }
  }

  const recent = await ctx.db
    .select({ release: releases, channelName: channels.name })
    .from(releases)
    .innerJoin(channels, eq(channels.id, releases.channelId))
    .where(eq(releases.projectId, projectId))
    .orderBy(desc(releases.id))
    .limit(10);

  return {
    project: {
      id: project.id,
      orgId: project.orgId,
      name: project.name,
      slug: project.slug,
      appKey: project.appKey,
      publicKey: project.publicKey,
      deepLinkScheme: project.deepLinkScheme,
      createdAt: project.createdAt.toISOString(),
    },
    channels: health,
    totalActiveDevices,
    recentReleases: recent.map((r) => toReleaseDto(r.release, r.channelName)),
    recentRollbacks: await listRollbacks(ctx, projectId, 10),
  };
}

export function toReleaseDto(
  row: typeof releases.$inferSelect,
  channelName: string,
): Release {
  return {
    id: row.id,
    projectId: row.projectId,
    channel: channelName,
    platform: row.platform as Platform,
    label: row.label,
    groupId: row.groupId,
    runtimeVersion: row.runtimeVersion,
    status: row.status as Release["status"],
    mandatory: row.mandatory,
    rolloutPercent: row.rolloutPercent,
    sha256: row.sha256,
    size: row.size,
    storageKey: row.storageKey,
    message: row.message,
    gitCommit: row.gitCommit,
    createdAt: row.createdAt.toISOString(),
  };
}
