/**
 * PostgreSQL schema (Supabase, self-hosted, and Cloudflare via Hyperdrive).
 *
 * ponytail: one dialect. The repository layer is the only place that talks to
 * Drizzle, so a second dialect (D1/SQLite) can be added there without touching
 * services — but shipping two dialects before anyone asked for D1 doubles the
 * test matrix for no user today. Cloudflare works now over Hyperdrive.
 */

import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const now = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/* ------------------------------------------------------------ identity */

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  createdAt: now(),
});

export const plans = pgTable("plans", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  maxProjects: integer("max_projects").notNull(),
  maxActiveDevices: integer("max_active_devices").notNull(),
  maxStorageGb: integer("max_storage_gb").notNull(),
  priceMonthCents: integer("price_month_cents").notNull().default(0),
  stripePriceId: text("stripe_price_id"),
});

export const orgs = pgTable("orgs", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  planId: text("plan_id")
    .notNull()
    .default("free")
    .references(() => plans.id),
  trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
  createdAt: now(),
});

export const orgMembers = pgTable(
  "org_members",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: now(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);

/** Mirror of Stripe state; Stripe itself stays the source of truth. */
export const subscriptions = pgTable("subscriptions", {
  orgId: uuid("org_id")
    .primaryKey()
    .references(() => orgs.id, { onDelete: "cascade" }),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  status: text("status").notNull().default("none"),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Webhook idempotency: a redelivered event must not double-apply. */
export const stripeEvents = pgTable("stripe_events", {
  id: text("id").primaryKey(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const emailVerifications = pgTable("email_verifications", {
  tokenHash: text("token_hash").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: now(),
});

/* ------------------------------------------------------------ projects */

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    /** Public identifier the app ships with; identifies, never authorises. */
    appKey: text("app_key").notNull().unique(),
    publicKey: text("public_key").notNull(),
    /** RSA private key sealed with AES-256-GCM under OTA_MASTER_KEY. */
    privateKeyEnc: text("private_key_enc").notNull(),
    deepLinkScheme: text("deep_link_scheme"),
    createdAt: now(),
  },
  (t) => [uniqueIndex("projects_org_slug_idx").on(t.orgId, t.slug)],
);

export const channels = pgTable(
  "channels",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: now(),
  },
  (t) => [uniqueIndex("channels_project_name_idx").on(t.projectId, t.name)],
);

export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    /** null = every project in the org. */
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    scopes: text("scopes").array().notNull().default(sql`ARRAY['admin']::text[]`),
    /** manual = created in settings; oauth = issued by the MCP OAuth flow. */
    kind: text("kind").notNull().default("manual"),
    refreshTokenHash: text("refresh_token_hash"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: now(),
  },
  (t) => [index("api_tokens_org_idx").on(t.orgId)],
);

/* ------------------------------------------------------------ releases */

export const releases = pgTable(
  "releases",
  {
    /** UUIDv7: ordering by id is ordering by publish time. */
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    /** Human label ("v42"), sequential per project+channel+platform. */
    label: integer("label").notNull(),
    /** Groups the iOS and Android releases of a single publish. */
    groupId: uuid("group_id"),
    runtimeVersion: text("runtime_version").notNull(),
    status: text("status").notNull().default("pending"),
    mandatory: boolean("mandatory").notNull().default(false),
    rolloutPercent: smallint("rollout_percent").notNull().default(100),
    storageKey: text("storage_key").notNull(),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    sha256: text("sha256").notNull(),
    signature: text("signature"),
    message: text("message"),
    gitCommit: text("git_commit"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex("releases_label_idx").on(t.projectId, t.channelId, t.platform, t.label),
    // The update-check lookup: everything it filters on, in one index.
    index("releases_lookup_idx").on(t.projectId, t.channelId, t.platform, t.runtimeVersion, t.status),
    index("releases_group_idx").on(t.groupId),
  ],
);

/* ----------------------------------------------------------- telemetry */

/**
 * One row per installation. The update-check IS the heartbeat, so this table
 * is written at most once an hour per device unless something changed —
 * O(devices), never O(events).
 */
export const devices = pgTable(
  "devices",
  {
    id: text("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    channel: text("channel").notNull(),
    nativeVersion: text("native_version"),
    runtimeVersion: text("runtime_version"),
    currentReleaseId: uuid("current_release_id").references(() => releases.id, {
      onDelete: "set null",
    }),
    previewReleaseId: uuid("preview_release_id").references(() => releases.id, {
      onDelete: "set null",
    }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("devices_active_idx").on(t.projectId, t.lastSeenAt),
    index("devices_release_idx").on(t.projectId, t.currentReleaseId),
    index("devices_native_idx").on(t.projectId, t.nativeVersion),
  ],
);

/** Daily counters — the whole funnel, at O(releases × days). */
export const releaseStats = pgTable(
  "release_stats",
  {
    releaseId: uuid("release_id")
      .notNull()
      .references(() => releases.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    downloads: integer("downloads").notNull().default(0),
    installs: integer("installs").notNull().default(0),
    ready: integer("ready").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    rollbacks: integer("rollbacks").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.releaseId, t.day] })],
);

/** The one raw event worth keeping: rare, and the first thing you want in an incident. */
export const rollbackEvents = pgTable(
  "rollback_events",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    releaseId: uuid("release_id")
      .notNull()
      .references(() => releases.id, { onDelete: "cascade" }),
    fromReleaseId: uuid("from_release_id").references(() => releases.id, { onDelete: "set null" }),
    deviceId: text("device_id").notNull(),
    reason: text("reason").notNull(),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: now(),
  },
  (t) => [index("rollback_events_project_idx").on(t.projectId, t.createdAt)],
);

/* --------------------------------------------------------------- oauth */

/** Dynamic Client Registration: MCP clients register themselves. */
export const oauthClients = pgTable("oauth_clients", {
  id: text("id").primaryKey(),
  clientName: text("client_name").notNull(),
  redirectUris: text("redirect_uris").array().notNull(),
  createdAt: now(),
});

export const oauthCodes = pgTable("oauth_codes", {
  code: text("code").primaryKey(),
  clientId: text("client_id").notNull(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  orgId: uuid("org_id")
    .notNull()
    .references(() => orgs.id, { onDelete: "cascade" }),
  redirectUri: text("redirect_uri").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  codeChallengeMethod: text("code_challenge_method").notNull().default("S256"),
  scope: text("scope").notNull().default("admin"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: now(),
});

/* ----------------------------------------------------------- relations */

export const orgRelations = relations(orgs, ({ many, one }) => ({
  members: many(orgMembers),
  projects: many(projects),
  plan: one(plans, { fields: [orgs.planId], references: [plans.id] }),
}));

export const projectRelations = relations(projects, ({ many, one }) => ({
  org: one(orgs, { fields: [projects.orgId], references: [orgs.id] }),
  channels: many(channels),
  releases: many(releases),
}));

export const releaseRelations = relations(releases, ({ one, many }) => ({
  project: one(projects, { fields: [releases.projectId], references: [projects.id] }),
  channel: one(channels, { fields: [releases.channelId], references: [channels.id] }),
  stats: many(releaseStats),
}));

export const schema = {
  users,
  plans,
  orgs,
  orgMembers,
  subscriptions,
  stripeEvents,
  emailVerifications,
  projects,
  channels,
  apiTokens,
  releases,
  devices,
  releaseStats,
  rollbackEvents,
  oauthClients,
  oauthCodes,
};

export type DbSchema = typeof schema;
export type ReleaseRow = typeof releases.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type DeviceRow = typeof devices.$inferSelect;
export type OrgRow = typeof orgs.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type ApiTokenRow = typeof apiTokens.$inferSelect;
