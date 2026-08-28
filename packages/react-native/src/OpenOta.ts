/**
 * Public API. The native module owns disk, verification and the boot path;
 * this file only decides what should happen and in which order.
 *
 * Update flow: docs/ARCHITECTURE.md §3.2 · wire protocol: docs/API.md §2.
 */

import {
  APP_KEY_HEADER,
  MAX_FAILED_RELEASES,
  SDK_VERSION_HEADER,
  updateCheckResponseSchema,
  type Platform,
  type UpdateCheckResponse,
} from "@open-ota/shared";
import { EventQueue, flushOnBackground, type KeyValueStore } from "./events.js";
import { currentPlatform, nativeModule } from "./native.js";
import type { OtaEventMap, OtaStatus, ReleaseRef, Subscription, SyncResult } from "./types.js";
import { SDK_VERSION } from "./version.js";

export type AvailableUpdate = Extract<UpdateCheckResponse, { action: "update" }>;

export interface OtaOptions {
  /** AsyncStorage or anything with getItem/setItem; without it telemetry is memory-only. */
  store?: KeyValueStore;
  fetchImpl?: typeof globalThis.fetch;
  /** Overrides the URL baked into the binary — local development only. */
  apiUrl?: string;
  /** Update-check timeout; a slow network must never delay a launch. */
  timeoutMs?: number;
}

const options: OtaOptions = {};
let queue: EventQueue | undefined;
let backgroundFlush: { remove(): void } | null = null;
let nativeStatesWired = false;

export function configure(next: OtaOptions): void {
  Object.assign(options, next);
  if (next.store || next.fetchImpl || next.apiUrl) {
    backgroundFlush?.remove();
    backgroundFlush = null;
    queue = undefined;
  }
}

function apiUrl(): string {
  return (options.apiUrl ?? nativeModule().apiUrl).replace(/\/+$/, "");
}

function doFetch(): typeof globalThis.fetch {
  return options.fetchImpl ?? globalThis.fetch;
}

async function events(known?: OtaStatus): Promise<EventQueue> {
  if (queue) return queue;
  const native = nativeModule();
  const status = known ?? (await native.getStatus());
  queue = new EventQueue({
    apiUrl: apiUrl(),
    appKey: native.appKey,
    device: status.deviceId,
    context: {
      platform: currentPlatform(),
      channel: status.channel,
      native: status.nativeVersion,
      runtime: status.runtimeVersion,
    },
    store: options.store,
    fetchImpl: options.fetchImpl,
  });
  backgroundFlush = flushOnBackground(queue);
  if (!nativeStatesWired) {
    // Registered once for the life of the process: a second subscription would
    // count every native rollback twice.
    nativeStatesWired = true;
    native.addListener("updateState", (state) => queue?.enqueueNativeState(state));
  }
  return queue;
}

/* --------------------------------------------------------- request building */

export interface UpdateCheckParams {
  platform: Platform;
  channel: string;
  runtime: string;
  device: string;
  current?: string | null;
  floor?: string | null;
  native?: string | null;
  failed?: readonly string[];
}

export function buildUpdateCheckUrl(baseUrl: string, params: UpdateCheckParams): string {
  const query: Array<[string, string]> = [
    ["platform", params.platform],
    ["channel", params.channel],
    ["runtime", params.runtime],
    ["device", params.device],
  ];
  if (params.current) query.push(["current", params.current]);
  if (params.floor) query.push(["floor", params.floor]);
  if (params.native) query.push(["native", params.native]);

  // Keep the most recent failures: the server only needs enough to stop
  // re-offering what just broke, and the query string has to stay sane.
  const failed = (params.failed ?? []).filter(Boolean).slice(-MAX_FAILED_RELEASES);
  if (failed.length > 0) query.push(["failed", failed.join(",")]);

  const search = query
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  // Built by hand: React Native's URL polyfill has no working searchParams.
  return `${baseUrl.replace(/\/+$/, "")}/api/v1/update-check?${search}`;
}

export function updateCheckHeaders(appKey: string): Record<string, string> {
  return {
    accept: "application/json",
    [APP_KEY_HEADER]: appKey,
    [SDK_VERSION_HEADER]: SDK_VERSION,
  };
}

/* -------------------------------------------------------- decision (pure) */

export type SyncPlan =
  | { action: "none" }
  | { action: "rollBackToEmbedded" }
  | { action: "incompatible"; runtimeVersion: string }
  | { action: "download"; update: AvailableUpdate; reload: boolean };

export function planFrom(
  response: UpdateCheckResponse,
  status: Pick<OtaStatus, "currentRelease" | "pendingRelease">,
  runtimeVersion: string,
): SyncPlan {
  switch (response.action) {
    case "none":
      return { action: "none" };
    case "rollBackToEmbedded":
      // Already on the embedded bundle: nothing to undo.
      return status.currentRelease ? { action: "rollBackToEmbedded" } : { action: "none" };
    case "update": {
      const { manifest } = response;
      if (status.currentRelease && manifest.id === status.currentRelease.id) {
        return { action: "none" };
      }
      if (status.pendingRelease && manifest.id === status.pendingRelease.id) {
        return { action: "none" };
      }
      if (manifest.runtimeVersion !== runtimeVersion) {
        return { action: "incompatible", runtimeVersion: manifest.runtimeVersion };
      }
      return { action: "download", update: response, reload: response.mandatory };
    }
  }
}

/* ------------------------------------------------------------------- flows */

async function fetchUpdateCheck(
  status: OtaStatus,
): Promise<{ response: UpdateCheckResponse; manifestJson: string | null }> {
  const native = nativeModule();
  const url = buildUpdateCheckUrl(apiUrl(), {
    platform: currentPlatform(),
    channel: status.channel,
    runtime: status.runtimeVersion,
    device: status.deviceId,
    current: status.currentRelease?.id,
    floor: native.embeddedFloorId,
    native: status.nativeVersion,
    failed: status.failedReleases,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const res = await doFetch()(url, {
      headers: updateCheckHeaders(native.appKey),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`update-check failed with ${res.status}`);
    const raw: unknown = await res.json();
    const response = updateCheckResponseSchema.parse(raw);
    // Hand the native verifier the server's own manifest object: a field we do
    // not know about is still covered by the signature, and zod would strip it.
    const manifestJson =
      response.action === "update"
        ? JSON.stringify((raw as { manifest: unknown }).manifest)
        : null;
    return { response, manifestJson };
  } finally {
    clearTimeout(timer);
  }
}

async function install(
  update: AvailableUpdate,
  manifestJson: string,
  reload: boolean,
): Promise<ReleaseRef> {
  const native = nativeModule();
  const release: ReleaseRef = { id: update.manifest.id, label: update.manifest.label };
  await native.downloadUpdate(manifestJson, update.signature, update.url);
  (await events()).enqueue({ type: "download", release: release.id });
  await native.applyUpdate(reload);
  (await events()).enqueue({ type: "install", release: release.id });
  void (await events()).flush(true);
  return release;
}

/**
 * Check, download and apply in one call. Mandatory updates reload right away;
 * everything else takes effect on the next launch. Never throws — a failed
 * sync must not take the app down with it.
 */
async function sync(): Promise<SyncResult> {
  try {
    const native = nativeModule();
    const status = await native.getStatus();
    void (await events(status)).flush();

    // Preview pins the device to one release until exitPreview().
    if (status.isPreview) return { status: "pinned" };

    const { response, manifestJson } = await fetchUpdateCheck(status);
    const plan = planFrom(response, status, status.runtimeVersion);

    switch (plan.action) {
      case "none":
        return { status: "upToDate" };
      case "incompatible":
        return { status: "incompatible", runtimeVersion: plan.runtimeVersion };
      case "rollBackToEmbedded":
        await native.rollback("server");
        return { status: "rolledBack" };
      case "download": {
        const json = manifestJson ?? JSON.stringify(plan.update.manifest);
        const release = await install(plan.update, json, plan.reload);
        return {
          status: "updated",
          release,
          mandatory: plan.update.mandatory,
          reloaded: plan.reload,
        };
      }
    }
  } catch (error) {
    return { status: "error", error: error instanceof Error ? error : new Error(String(error)) };
  }
}

async function checkForUpdate(): Promise<UpdateCheckResponse> {
  const status = await nativeModule().getStatus();
  const { response } = await fetchUpdateCheck(status);
  return response;
}

/** Manual counterpart to sync(): download a specific update and stage it. */
async function downloadUpdate(update: AvailableUpdate, reload = false): Promise<ReleaseRef> {
  return install(update, JSON.stringify(update.manifest), reload);
}

/**
 * Confirms the running bundle actually booted. Until it is called the native
 * side keeps a pendingVerification flag and the next launch rolls back.
 */
async function notifyAppReady(): Promise<void> {
  const native = nativeModule();
  await native.notifyAppReady();
  const status = await native.getStatus();
  if (status.currentRelease) {
    (await events()).enqueue({ type: "ready", release: status.currentRelease.id });
  }
  void (await events()).flush(true);
}

function getStatus(): Promise<OtaStatus> {
  return nativeModule().getStatus();
}

async function setChannel(channel: string): Promise<void> {
  await nativeModule().setChannel(channel);
}

function reload(): Promise<void> {
  return nativeModule().reload();
}

/** Leaves preview mode and lets the normal update-check resume. */
function exitPreview(): Promise<void> {
  return nativeModule().exitPreview();
}

function clearFailed(): Promise<void> {
  return nativeModule().clearFailed();
}

function addListener<E extends keyof OtaEventMap>(
  event: E,
  listener: (payload: OtaEventMap[E]) => void,
): Subscription {
  return nativeModule().addListener(event, listener);
}

export const OpenOta = {
  configure,
  sync,
  checkForUpdate,
  downloadUpdate,
  notifyAppReady,
  getStatus,
  setChannel,
  reload,
  exitPreview,
  clearFailed,
  addListener,
  /** Flushes pending telemetry; called on launch and on background already. */
  flushEvents: async (): Promise<boolean> => (await events()).flush(true),
};
