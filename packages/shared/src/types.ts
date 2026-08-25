/** Admin API data transfer objects — shared by server, dashboard, CLI and MCP. */

import type { Platform, ReleaseStatus, RollbackReason } from "./protocol.js";

export type OrgRole = "owner" | "admin" | "member";
export type TokenScope = "admin" | "read";

export interface Org {
  id: string;
  name: string;
  slug: string;
  planId: string;
  trialEndsAt: string | null;
  createdAt: string;
}

export interface Plan {
  id: string;
  name: string;
  maxProjects: number;
  maxActiveDevices: number;
  maxStorageGb: number;
  priceMonthCents: number;
}

export interface OrgUsage {
  projects: { used: number; limit: number };
  activeDevices: { used: number; limit: number };
  storageGb: { used: number; limit: number };
  overQuota: boolean;
}

export interface Subscription {
  status: "none" | "trialing" | "active" | "past_due" | "canceled";
  planId: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export interface Project {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  appKey: string;
  publicKey: string;
  deepLinkScheme: string | null;
  createdAt: string;
}

export interface Channel {
  id: string;
  projectId: string;
  name: string;
  createdAt: string;
}

export interface Release {
  id: string;
  projectId: string;
  channel: string;
  platform: Platform;
  label: number;
  groupId: string | null;
  runtimeVersion: string;
  status: ReleaseStatus;
  mandatory: boolean;
  rolloutPercent: number;
  sha256: string;
  size: number;
  storageKey: string;
  message: string | null;
  gitCommit: string | null;
  createdAt: string;
}

export interface ReleaseFunnel {
  downloads: number;
  installs: number;
  ready: number;
  failed: number;
  rollbacks: number;
  /** ready / installs — the number that says whether a release is healthy. */
  successRate: number | null;
  rollbackRate: number | null;
}

export interface ReleaseMetrics extends ReleaseFunnel {
  releaseId: string;
  label: number;
  activeDevices: number;
  daily: Array<{
    day: string;
    downloads: number;
    installs: number;
    ready: number;
    failed: number;
    rollbacks: number;
  }>;
}

export interface VersionDistributionRow {
  releaseId: string | null;
  label: number | null;
  platform: Platform;
  devices: number;
  percentOfBase: number;
  installs: number;
  rollbacks: number;
}

export interface NativeVersionRow {
  nativeVersion: string;
  platform: Platform;
  devices: number;
  percentOfBase: number;
}

export interface RollbackEvent {
  id: string;
  releaseId: string;
  releaseLabel: number | null;
  fromReleaseId: string | null;
  deviceId: string;
  reason: RollbackReason;
  platform: Platform | null;
  nativeVersion: string | null;
  message: string | null;
  createdAt: string;
}

export interface ChannelHealth {
  channel: string;
  platform: Platform;
  currentRelease: Release | null;
  activeDevices: number;
  adoptionPercent: number | null;
  successRate: number | null;
  rollbackRate: number | null;
}

export interface ProjectOverview {
  project: Project;
  channels: ChannelHealth[];
  totalActiveDevices: number;
  recentReleases: Release[];
  recentRollbacks: RollbackEvent[];
}

export interface ApiToken {
  id: string;
  name: string;
  projectId: string | null;
  scopes: TokenScope[];
  lastUsedAt: string | null;
  createdAt: string;
  /** Only present in the create response — never stored in the clear. */
  token?: string;
}

export interface PrepareUploadRequest {
  sha256: string;
  size: number;
  platform: Platform;
  channel: string;
  runtimeVersion: string;
  rolloutPercent?: number;
  mandatory?: boolean;
  message?: string;
  gitCommit?: string;
  groupId?: string;
}

export interface PrepareUploadResponse {
  releaseId: string;
  uploadUrl: string;
  /** Headers the client must replay on the PUT (content type, checksums). */
  uploadHeaders: Record<string, string>;
  storageKey: string;
  /** Set when the storage adapter cannot issue signed URLs (local disk). */
  uploadViaServer?: boolean;
}

export interface PreviewLinkResponse {
  url: string;
  expiresAt: string;
  scheme: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}
