/**
 * Plans and quota enforcement.
 *
 * Product rule: exceeding a quota blocks NEW publishes. It never blocks
 * update-check or bundle downloads — a customer's end users must not have
 * their app break because of a billing state they cannot see.
 */

import type { OrgUsage, Subscription } from "@open-ota/shared";
import { and, eq, gte, sql } from "drizzle-orm";
import { devices, orgs, plans, projects, releases, subscriptions } from "../db/schema.js";
import type { AppContext } from "./context.js";
import { ApiError } from "./errors.js";
import { DEFAULT_WINDOW_DAYS } from "./metrics.js";

export const DEFAULT_PLANS = [
  { id: "free", name: "Free", maxProjects: 1, maxActiveDevices: 1_000, maxStorageGb: 1, priceMonthCents: 0 },
  { id: "pro", name: "Pro", maxProjects: 5, maxActiveDevices: 50_000, maxStorageGb: 20, priceMonthCents: 4900 },
  { id: "scale", name: "Scale", maxProjects: 50, maxActiveDevices: 1_000_000, maxStorageGb: 200, priceMonthCents: 24900 },
] as const;

/** Self-hosted installs are not metered; the limits exist only in hosted mode. */
const UNLIMITED = {
  id: "self-hosted",
  name: "Self-hosted",
  maxProjects: Number.MAX_SAFE_INTEGER,
  maxActiveDevices: Number.MAX_SAFE_INTEGER,
  maxStorageGb: Number.MAX_SAFE_INTEGER,
  priceMonthCents: 0,
};

export async function seedPlans(ctx: AppContext): Promise<void> {
  for (const plan of DEFAULT_PLANS) {
    await ctx.db.insert(plans).values({ ...plan }).onConflictDoNothing();
  }
}

export async function getPlanFor(ctx: AppContext, orgId: string) {
  if (!ctx.config.hosted) return UNLIMITED;

  const [row] = await ctx.db
    .select({ plan: plans })
    .from(orgs)
    .innerJoin(plans, eq(plans.id, orgs.planId))
    .where(eq(orgs.id, orgId));

  return row?.plan ?? DEFAULT_PLANS[0];
}

export async function getUsage(ctx: AppContext, orgId: string): Promise<OrgUsage> {
  const plan = await getPlanFor(ctx, orgId);
  const since = new Date(ctx.now().getTime() - DEFAULT_WINDOW_DAYS * 86_400_000);

  const [projectCount] = await ctx.db
    .select({ count: sql<number>`count(*)::int` })
    .from(projects)
    .where(eq(projects.orgId, orgId));

  const [deviceCount] = await ctx.db
    .select({ count: sql<number>`count(*)::int` })
    .from(devices)
    .innerJoin(projects, eq(projects.id, devices.projectId))
    .where(and(eq(projects.orgId, orgId), gte(devices.lastSeenAt, since)));

  const [storage] = await ctx.db
    .select({ bytes: sql<number>`coalesce(sum(${releases.size}), 0)::bigint` })
    .from(releases)
    .innerJoin(projects, eq(projects.id, releases.projectId))
    .where(eq(projects.orgId, orgId));

  const storageGb = Math.round((Number(storage?.bytes ?? 0) / 1024 ** 3) * 100) / 100;

  const usage: OrgUsage = {
    projects: { used: projectCount?.count ?? 0, limit: plan.maxProjects },
    activeDevices: { used: deviceCount?.count ?? 0, limit: plan.maxActiveDevices },
    storageGb: { used: storageGb, limit: plan.maxStorageGb },
    overQuota: false,
  };
  usage.overQuota =
    usage.projects.used > usage.projects.limit ||
    usage.activeDevices.used > usage.activeDevices.limit ||
    usage.storageGb.used > usage.storageGb.limit;

  return usage;
}

export async function getSubscription(ctx: AppContext, orgId: string): Promise<Subscription> {
  const org = await ctx.db.query.orgs.findFirst({ where: eq(orgs.id, orgId) });
  const row = await ctx.db.query.subscriptions.findFirst({ where: eq(subscriptions.orgId, orgId) });

  return {
    status: (row?.status as Subscription["status"]) ?? (ctx.config.hosted ? "none" : "active"),
    planId: org?.planId ?? "free",
    currentPeriodEnd: row?.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: row?.cancelAtPeriodEnd ?? false,
  };
}

/** Called before creating a project or accepting a new bundle. */
export async function assertCanPublish(ctx: AppContext, orgId: string, bundleBytes = 0): Promise<void> {
  if (!ctx.config.hosted) return;

  const usage = await getUsage(ctx, orgId);
  const projectedGb = usage.storageGb.used + bundleBytes / 1024 ** 3;

  if (usage.activeDevices.used > usage.activeDevices.limit) {
    throw ApiError.quotaExceeded(
      `This organisation is over its device limit (${usage.activeDevices.used} of ${usage.activeDevices.limit}). Existing apps keep receiving updates — upgrade to publish new ones.`,
      { usage },
    );
  }
  if (projectedGb > usage.storageGb.limit) {
    throw ApiError.quotaExceeded(
      `This bundle would take the organisation past its ${usage.storageGb.limit} GB storage limit.`,
      { usage },
    );
  }
}

export async function assertCanCreateProject(ctx: AppContext, orgId: string): Promise<void> {
  if (!ctx.config.hosted) return;
  const usage = await getUsage(ctx, orgId);
  if (usage.projects.used >= usage.projects.limit) {
    throw ApiError.quotaExceeded(
      `The ${(await getPlanFor(ctx, orgId)).name} plan includes ${usage.projects.limit} project(s).`,
      { usage },
    );
  }
}
