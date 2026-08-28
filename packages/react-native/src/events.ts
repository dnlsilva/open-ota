/**
 * Telemetry queue for POST /api/v1/events (docs/API.md §2.3).
 *
 * Events are counters, so dropping some is fine and duplicating a whole batch
 * is not: a single in-flight flush plus "requeue only when the server never
 * saw the batch" (network error / 5xx / 429) buys that cheaply. Anything the
 * server answered — 2xx or 4xx — is discarded rather than retried.
 *
 * Persistence is a two-method store so the app can hand us AsyncStorage in one
 * line; without one the queue lives in memory and a cold launch loses it.
 */

import {
  APP_KEY_HEADER,
  SDK_VERSION_HEADER,
  type DeviceEvent,
  type EventType,
  type EventsRequest,
  type Platform,
} from "@open-ota/shared";
import { SDK_VERSION } from "./version.js";
import type { UpdateState } from "./types.js";

/** Matches both `localStorage` and AsyncStorage. */
export interface KeyValueStore {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): unknown;
}

export const EVENT_STORE_KEY = "open-ota.events";

/** eventsRequestSchema caps a request at 50 events. */
const MAX_BATCH = 50;
const MAX_QUEUED = 200;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export interface EventQueueOptions {
  apiUrl: string;
  appKey: string;
  device: string;
  context?: { platform?: Platform; channel?: string; native?: string; runtime?: string };
  store?: KeyValueStore;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => number;
  maxQueued?: number;
  batchSize?: number;
}

export class EventQueue {
  private queue: DeviceEvent[] = [];
  private flushing = false;
  private failures = 0;
  private nextAttemptAt = 0;
  private loaded = false;
  private readonly maxQueued: number;
  private readonly batchSize: number;
  private readonly now: () => number;

  constructor(private readonly options: EventQueueOptions) {
    this.maxQueued = options.maxQueued ?? MAX_QUEUED;
    this.batchSize = Math.min(options.batchSize ?? MAX_BATCH, MAX_BATCH);
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.queue.length;
  }

  /** Reads back whatever survived the last process. Safe to call repeatedly. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const store = this.options.store;
    if (!store) return;
    try {
      const raw = await store.getItem(EVENT_STORE_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) this.queue = [...(parsed as DeviceEvent[]), ...this.queue];
    } catch {
      /* corrupt queue: counters, not data — drop it */
    }
  }

  enqueue(event: Omit<DeviceEvent, "ts"> & { ts?: number }): void {
    this.queue.push({ ...event, ts: event.ts ?? Math.floor(this.now() / 1000) });
    if (this.queue.length > this.maxQueued) {
      this.queue.splice(0, this.queue.length - this.maxQueued);
    }
    void this.persist();
  }

  /** Native reports outcomes JS never sees — a crash rollback on the last boot. */
  enqueueNativeState(event: UpdateState): void {
    const type = NATIVE_STATE_EVENTS[event.state];
    if (!type) return;
    if (event.state === "rollback") {
      this.enqueue({
        type,
        release: event.releaseId,
        meta: { reason: event.reason, from: event.fromReleaseId },
      });
      return;
    }
    if (event.state === "verifyFailed") {
      this.enqueue({ type, release: event.releaseId, meta: { stage: event.stage } });
      return;
    }
  }

  /** Sends every queued batch. Returns false if anything is still pending. */
  async flush(force = false): Promise<boolean> {
    await this.load();
    if (this.flushing) return false;
    if (!force && this.now() < this.nextAttemptAt) return false;
    if (this.queue.length === 0) return true;

    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.slice(0, this.batchSize);
        const outcome = await this.send(batch);
        if (outcome === "retry") {
          this.failures++;
          this.nextAttemptAt =
            this.now() + Math.min(BASE_BACKOFF_MS * 2 ** (this.failures - 1), MAX_BACKOFF_MS);
          return false;
        }
        // Accepted or rejected: either way the server will not see it again.
        this.queue.splice(0, batch.length);
        void this.persist();
      }
      this.failures = 0;
      this.nextAttemptAt = 0;
      return true;
    } finally {
      this.flushing = false;
    }
  }

  private async send(events: DeviceEvent[]): Promise<"done" | "retry"> {
    const body: EventsRequest = {
      device: this.options.device,
      platform: this.options.context?.platform,
      channel: this.options.context?.channel,
      native: this.options.context?.native,
      runtime: this.options.context?.runtime,
      events,
    };
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    try {
      const res = await fetchImpl(`${trimSlash(this.options.apiUrl)}/api/v1/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [APP_KEY_HEADER]: this.options.appKey,
          [SDK_VERSION_HEADER]: SDK_VERSION,
        },
        body: JSON.stringify(body),
      });
      return res.status >= 500 || res.status === 429 ? "retry" : "done";
    } catch {
      return "retry";
    }
  }

  private async persist(): Promise<void> {
    const store = this.options.store;
    if (!store) return;
    try {
      await store.setItem(EVENT_STORE_KEY, JSON.stringify(this.queue));
    } catch {
      /* full or unavailable storage must never break an update */
    }
  }
}

const NATIVE_STATE_EVENTS: Partial<Record<UpdateState["state"], EventType>> = {
  rollback: "rollback",
  verifyFailed: "verifyFailed",
};

/**
 * Flush when the app leaves the foreground — the other guaranteed moment
 * besides launch. Returns a remover, or null when react-native is absent.
 */
export function flushOnBackground(queue: EventQueue): { remove(): void } | null {
  try {
    const { AppState } = require("react-native") as {
      AppState: {
        addEventListener: (t: string, cb: (s: string) => void) => { remove(): void };
      };
    };
    return AppState.addEventListener("change", (state) => {
      if (state === "background" || state === "inactive") void queue.flush(true);
    });
  } catch {
    return null;
  }
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
