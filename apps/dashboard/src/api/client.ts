import { useQuery } from "@tanstack/react-query";
import { OtaClient, OtaApiError } from "@open-ota/shared";
import type { Plan, Platform, ReleaseStatus } from "@open-ota/shared";

export { OtaApiError };

declare global {
  interface Window {
    /** Injected by the host page: the server serving this SPA, or `ota console`. */
    __OTA_API_URL__?: string;
  }
}

const TOKEN_KEY = "ota.token";

export function resolveApiBaseUrl(): string {
  const injected = typeof window !== "undefined" ? window.__OTA_API_URL__ : undefined;
  const base = injected || import.meta.env.VITE_API_URL || window.location.origin;
  return base.replace(/\/+$/, "");
}

export function readStoredToken(): string | undefined {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined; // private mode / storage disabled
  }
}

export function storeToken(token: string | undefined): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

let unauthorizedHandler: () => void = () => {};

/** The app registers a handler so a 401 anywhere lands on /login with state kept. */
export function setUnauthorizedHandler(handler: () => void): void {
  unauthorizedHandler = handler;
}

export const apiBaseUrl = resolveApiBaseUrl();

export const client = new OtaClient({
  baseUrl: apiBaseUrl,
  token: readStoredToken(),
  onUnauthorized: () => unauthorizedHandler(),
});

export function setAuthToken(token: string | undefined): void {
  client.token = token;
  storeToken(token);
}

/* ------------------------------------------------------------------ config */

export interface ServerConfig {
  mode: "hosted" | "self";
  billingEnabled: boolean;
  signupEnabled: boolean;
}

const SELF_HOSTED_FALLBACK: ServerConfig = {
  mode: "self",
  billingEnabled: false,
  signupEnabled: false,
};

/* -------------------------------------------------------------- query keys */

export const qk = {
  config: ["config"] as const,
  me: ["me"] as const,
  plans: ["plans"] as const,
  projects: (orgId?: string) => ["projects", orgId ?? "all"] as const,
  project: (id: string) => ["project", id] as const,
  overview: (id: string) => ["overview", id] as const,
  distribution: (id: string, platform: Platform | "all", windowDays: number) =>
    ["distribution", id, platform, windowDays] as const,
  releases: (id: string, filters: ReleaseFilters) =>
    ["releases", id, filters.channel ?? "all", filters.platform ?? "all", filters.status ?? "all"] as const,
  release: (id: string) => ["release", id] as const,
  releaseMetrics: (id: string, days: number) => ["release-metrics", id, days] as const,
  rollbacks: (id: string) => ["rollbacks", id] as const,
  channels: (id: string) => ["channels", id] as const,
  tokens: (id: string) => ["tokens", id] as const,
  usage: (orgId: string) => ["usage", orgId] as const,
};

export interface ReleaseFilters {
  channel?: string;
  platform?: Platform;
  status?: ReleaseStatus;
}

/* ------------------------------------------------------------------ hooks */

/**
 * `/config` tells the SPA whether it is talking to a hosted deployment (signup
 * and billing) or a self-hosted one. A server that does not answer it is
 * treated as self-hosted, which only ever hides features.
 */
export function useServerConfig() {
  return useQuery({
    queryKey: qk.config,
    queryFn: async (): Promise<ServerConfig> => {
      try {
        return await client.request<ServerConfig>("GET", "/config");
      } catch {
        return SELF_HOSTED_FALLBACK;
      }
    },
    staleTime: Infinity,
    retry: false,
  });
}

export function useMe(enabled: boolean) {
  return useQuery({
    queryKey: qk.me,
    queryFn: () => client.me(),
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
  });
}

export function useProjects(orgId?: string) {
  return useQuery({
    queryKey: qk.projects(orgId),
    queryFn: () => client.listProjects(orgId),
  });
}

export function useProject(projectId: string | undefined) {
  return useQuery({
    queryKey: qk.project(projectId ?? ""),
    queryFn: () => client.getProject(projectId as string),
    enabled: Boolean(projectId),
  });
}

export function useOverview(projectId: string | undefined) {
  return useQuery({
    queryKey: qk.overview(projectId ?? ""),
    queryFn: () => client.getOverview(projectId as string),
    enabled: Boolean(projectId),
    refetchInterval: 60_000,
  });
}

export function useDistribution(
  projectId: string | undefined,
  platform: Platform | "all",
  windowDays: number,
) {
  return useQuery({
    queryKey: qk.distribution(projectId ?? "", platform, windowDays),
    queryFn: () =>
      client.getDistribution(projectId as string, {
        platform: platform === "all" ? undefined : platform,
        windowDays,
      }),
    enabled: Boolean(projectId),
  });
}

export function useReleases(projectId: string | undefined, filters: ReleaseFilters) {
  return useQuery({
    queryKey: qk.releases(projectId ?? "", filters),
    queryFn: () => client.listReleases(projectId as string, { ...filters, limit: 200 }),
    enabled: Boolean(projectId),
  });
}

export function useRelease(releaseId: string | undefined) {
  return useQuery({
    queryKey: qk.release(releaseId ?? ""),
    queryFn: () => client.getRelease(releaseId as string),
    enabled: Boolean(releaseId),
  });
}

export function useReleaseMetrics(releaseId: string | undefined | null, days = 14) {
  return useQuery({
    queryKey: qk.releaseMetrics(releaseId ?? "", days),
    queryFn: () => client.getReleaseMetrics(releaseId as string, days),
    enabled: Boolean(releaseId),
    refetchInterval: 60_000,
  });
}

export function useRollbacks(projectId: string | undefined, limit = 50) {
  return useQuery({
    queryKey: qk.rollbacks(projectId ?? ""),
    queryFn: () => client.listRollbacks(projectId as string, limit),
    enabled: Boolean(projectId),
  });
}

export function useChannels(projectId: string | undefined) {
  return useQuery({
    queryKey: qk.channels(projectId ?? ""),
    queryFn: () => client.listChannels(projectId as string),
    enabled: Boolean(projectId),
  });
}

export function useTokens(projectId: string | undefined) {
  return useQuery({
    queryKey: qk.tokens(projectId ?? ""),
    queryFn: () => client.listTokens(projectId as string),
    enabled: Boolean(projectId),
  });
}

export function useOrgUsage(orgId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: qk.usage(orgId ?? ""),
    queryFn: () => client.getOrgUsage(orgId as string),
    enabled: Boolean(orgId) && enabled,
  });
}

/** Plan catalogue for the upgrade cards; absent on deployments without billing. */
export function usePlans(enabled: boolean) {
  return useQuery({
    queryKey: qk.plans,
    queryFn: async (): Promise<Plan[]> => {
      try {
        const res = await client.request<{ plans: Plan[] }>("GET", "/plans");
        return res.plans;
      } catch {
        return [];
      }
    },
    enabled,
    staleTime: Infinity,
    retry: false,
  });
}

export function errorMessage(error: unknown): string {
  if (error instanceof OtaApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Unexpected error";
}
