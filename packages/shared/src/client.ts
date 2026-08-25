/**
 * Admin API client. One implementation serves the dashboard, the CLI and the
 * MCP server, so a route added here reaches all three at once.
 */

import type {
  ApiToken,
  Channel,
  NativeVersionRow,
  Org,
  OrgUsage,
  PrepareUploadRequest,
  PrepareUploadResponse,
  PreviewLinkResponse,
  Project,
  ProjectOverview,
  Release,
  ReleaseMetrics,
  RollbackEvent,
  Subscription,
  VersionDistributionRow,
} from "./types.js";
import type { Platform, ReleaseStatus } from "./protocol.js";

export class OtaApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "OtaApiError";
  }
}

export interface OtaClientOptions {
  baseUrl: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
  /** Called when the server answers 401, so the CLI can prompt a re-login. */
  onUnauthorized?: () => void;
}

export class OtaClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  token?: string;

  constructor(private readonly options: OtaClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /* ------------------------------------------------------------------ core */

  async request<T>(
    method: string,
    path: string,
    init: { body?: unknown; query?: Record<string, string | number | boolean | undefined> } = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}/api/v1${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = { accept: "application/json" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (init.body !== undefined) headers["content-type"] = "application/json";

    const res = await this.fetchImpl(url.toString(), {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

    if (res.status === 401) this.options.onUnauthorized?.();

    if (!res.ok) {
      let code = "http_error";
      let message = `${method} ${path} failed with ${res.status}`;
      let details: unknown;
      try {
        const body = (await res.json()) as { error?: { code: string; message: string; details?: unknown } };
        if (body.error) {
          code = body.error.code;
          message = body.error.message;
          details = body.error.details;
        }
      } catch {
        /* non-JSON error body */
      }
      throw new OtaApiError(res.status, code, message, details);
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /* ------------------------------------------------------------------ auth */

  login(email: string, password: string) {
    return this.request<{ token: string; user: { id: string; email: string }; orgs: Org[] }>(
      "POST",
      "/auth/login",
      { body: { email, password } },
    );
  }

  signup(email: string, password: string, orgName: string) {
    return this.request<{ userId: string; verificationRequired: boolean }>("POST", "/auth/signup", {
      body: { email, password, orgName },
    });
  }

  me() {
    return this.request<{ user: { id: string; email: string }; orgs: Org[] }>("GET", "/auth/me");
  }

  /* ------------------------------------------------------------------ orgs */

  listOrgs() {
    return this.request<{ orgs: Org[] }>("GET", "/orgs");
  }

  getOrgUsage(orgId: string) {
    return this.request<{ usage: OrgUsage; subscription: Subscription }>("GET", `/orgs/${orgId}/usage`);
  }

  /* -------------------------------------------------------------- projects */

  listProjects(orgId?: string) {
    return this.request<{ projects: Project[] }>("GET", "/projects", { query: { orgId } });
  }

  getProject(projectId: string) {
    return this.request<{ project: Project }>("GET", `/projects/${projectId}`);
  }

  createProject(input: { name: string; orgId?: string; deepLinkScheme?: string }) {
    return this.request<{ project: Project }>("POST", "/projects", { body: input });
  }

  getOverview(projectId: string) {
    return this.request<ProjectOverview>("GET", `/projects/${projectId}/overview`);
  }

  listChannels(projectId: string) {
    return this.request<{ channels: Channel[] }>("GET", `/projects/${projectId}/channels`);
  }

  createChannel(projectId: string, name: string) {
    return this.request<{ channel: Channel }>("POST", `/projects/${projectId}/channels`, {
      body: { name },
    });
  }

  /* -------------------------------------------------------------- releases */

  listReleases(
    projectId: string,
    query: { channel?: string; platform?: Platform; status?: ReleaseStatus; limit?: number } = {},
  ) {
    return this.request<{ releases: Release[] }>("GET", `/projects/${projectId}/releases`, { query });
  }

  getRelease(releaseId: string) {
    return this.request<{ release: Release }>("GET", `/releases/${releaseId}`);
  }

  prepareUpload(projectId: string, input: PrepareUploadRequest) {
    return this.request<PrepareUploadResponse>("POST", `/projects/${projectId}/releases/prepare-upload`, {
      body: input,
    });
  }

  confirmRelease(releaseId: string) {
    return this.request<{ release: Release }>("POST", `/releases/${releaseId}/confirm`);
  }

  updateRelease(
    releaseId: string,
    patch: { status?: ReleaseStatus; rolloutPercent?: number; mandatory?: boolean; message?: string },
  ) {
    return this.request<{ release: Release }>("PATCH", `/releases/${releaseId}`, { body: patch });
  }

  promoteRelease(releaseId: string, channel: string, rolloutPercent?: number) {
    return this.request<{ release: Release }>("POST", `/releases/${releaseId}/promote`, {
      body: { channel, rolloutPercent },
    });
  }

  rollbackRelease(releaseId: string) {
    return this.request<{ release: Release; target: Release | null }>(
      "POST",
      `/releases/${releaseId}/rollback`,
    );
  }

  createPreviewLink(releaseId: string, ttlMinutes?: number) {
    return this.request<PreviewLinkResponse>("POST", `/releases/${releaseId}/preview-link`, {
      body: { ttlMinutes },
    });
  }

  /* --------------------------------------------------------------- metrics */

  getReleaseMetrics(releaseId: string, days = 14) {
    return this.request<ReleaseMetrics>("GET", `/releases/${releaseId}/metrics`, { query: { days } });
  }

  getDistribution(projectId: string, query: { platform?: Platform; windowDays?: number } = {}) {
    return this.request<{
      releases: VersionDistributionRow[];
      nativeVersions: NativeVersionRow[];
      totalDevices: number;
    }>("GET", `/projects/${projectId}/distribution`, {
      query: { platform: query.platform, window: query.windowDays },
    });
  }

  listRollbacks(projectId: string, limit = 50) {
    return this.request<{ rollbacks: RollbackEvent[] }>("GET", `/projects/${projectId}/rollbacks`, {
      query: { limit },
    });
  }

  /* ---------------------------------------------------------------- tokens */

  listTokens(projectId: string) {
    return this.request<{ tokens: ApiToken[] }>("GET", `/projects/${projectId}/tokens`);
  }

  createToken(projectId: string, name: string, scopes: Array<"admin" | "read"> = ["admin"]) {
    return this.request<{ token: ApiToken }>("POST", `/projects/${projectId}/tokens`, {
      body: { name, scopes },
    });
  }

  deleteToken(tokenId: string) {
    return this.request<void>("DELETE", `/tokens/${tokenId}`);
  }

  /* --------------------------------------------------------------- billing */

  createCheckout(orgId: string, planId: string) {
    return this.request<{ url: string }>("POST", "/billing/checkout", { body: { orgId, planId } });
  }

  createBillingPortal(orgId: string) {
    return this.request<{ url: string }>("POST", "/billing/portal", { body: { orgId } });
  }
}
