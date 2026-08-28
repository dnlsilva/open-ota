import { beforeEach, describe, expect, it } from "vitest";
import type { EventsRequest } from "@open-ota/shared";
import {
  EVENT_STORE_KEY,
  EventQueue,
  type EventQueueOptions,
  type KeyValueStore,
} from "../src/events.js";

const RELEASE = "0193a4c8-0000-7000-8000-000000000002";

function memoryStore(): KeyValueStore & { readonly value: string | null } {
  const state: { value: string | null } = { value: null };
  return {
    get value() {
      return state.value;
    },
    getItem: () => state.value,
    setItem: (_key: string, value: string) => {
      state.value = value;
    },
  };
}

describe("event queue", () => {
  let sent: EventsRequest[];
  let statuses: number[];
  let now: number;

  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    sent.push(JSON.parse(init.body) as EventsRequest);
    const status = statuses.shift() ?? 202;
    if (status === 0) throw new Error("network down");
    return { status, ok: status < 400 };
  }) as unknown as typeof globalThis.fetch;

  function queue(overrides: Partial<EventQueueOptions> = {}) {
    return new EventQueue({
      apiUrl: "https://ota.example.com/",
      appKey: "pk_1",
      device: "3f7a1111",
      fetchImpl,
      now: () => now,
      ...overrides,
    });
  }

  beforeEach(() => {
    sent = [];
    statuses = [];
    now = 1_756_731_600_000;
  });

  it("posts to /api/v1/events with the app key and a timestamp per event", async () => {
    const urls: string[] = [];
    const q = queue({
      fetchImpl: (async (url: string, init: { headers: Record<string, string>; body: string }) => {
        urls.push(url);
        expect(init.headers["x-ota-app-key"]).toBe("pk_1");
        sent.push(JSON.parse(init.body) as EventsRequest);
        return { status: 202, ok: true };
      }) as unknown as typeof globalThis.fetch,
    });
    q.enqueue({ type: "download", release: RELEASE });
    expect(await q.flush()).toBe(true);
    expect(urls[0]).toBe("https://ota.example.com/api/v1/events");
    expect(sent[0]?.events[0]).toMatchObject({ type: "download", release: RELEASE });
    expect(sent[0]?.events[0]?.ts).toBe(Math.floor(now / 1000));
  });

  it("splits into batches of at most 50, the protocol maximum", async () => {
    const q = queue();
    for (let i = 0; i < 120; i++) q.enqueue({ type: "install", release: RELEASE });
    expect(await q.flush()).toBe(true);
    expect(sent.map((r) => r.events.length)).toEqual([50, 50, 20]);
    expect(q.size).toBe(0);
  });

  it("keeps the batch and backs off when the server never saw it", async () => {
    const q = queue();
    statuses = [500];
    q.enqueue({ type: "ready", release: RELEASE });
    expect(await q.flush()).toBe(false);
    expect(q.size).toBe(1);

    // Backoff holds off the next attempt until enough time has passed.
    expect(await q.flush()).toBe(false);
    expect(sent).toHaveLength(1);

    statuses = [202];
    expect(await q.flush(true)).toBe(true);
    expect(sent).toHaveLength(2);
    expect(q.size).toBe(0);
  });

  it("retries a network failure but never a rejection the server answered", async () => {
    const network = queue();
    statuses = [0];
    network.enqueue({ type: "download", release: RELEASE });
    expect(await network.flush()).toBe(false);
    expect(network.size).toBe(1);

    const rejected = queue();
    statuses = [400];
    rejected.enqueue({ type: "download", release: RELEASE });
    // Counters, not data: re-sending what the server already rejected would
    // only risk double counting.
    expect(await rejected.flush()).toBe(true);
    expect(rejected.size).toBe(0);
  });

  it("sends a batch once even when two flushes overlap", async () => {
    const q = queue();
    q.enqueue({ type: "install", release: RELEASE });
    const [first, second] = await Promise.all([q.flush(), q.flush()]);
    expect([first, second]).toContain(true);
    expect(sent).toHaveLength(1);
  });

  it("drops the oldest events once the queue is full", async () => {
    const q = queue({ maxQueued: 5 });
    for (let i = 0; i < 10; i++) q.enqueue({ type: "install", release: RELEASE, ts: i });
    expect(q.size).toBe(5);
    await q.flush();
    expect(sent[0]?.events.map((e) => e.ts)).toEqual([5, 6, 7, 8, 9]);
  });

  it("survives a cold launch through the store", async () => {
    const store = memoryStore();
    const first = queue({ store });
    first.enqueue({ type: "ready", release: RELEASE });
    await Promise.resolve();
    expect(store.value).toContain(RELEASE);

    statuses = [202];
    const second = queue({ store });
    expect(await second.flush()).toBe(true);
    expect(sent[0]?.events).toHaveLength(1);
    expect(store.value).toBe("[]");
    expect(EVENT_STORE_KEY).toBe("open-ota.events");
  });

  it("only forwards native states JS could not have observed itself", () => {
    const q = queue();
    q.enqueueNativeState({ state: "rollback", releaseId: RELEASE, reason: "crash", fromReleaseId: "x" });
    q.enqueueNativeState({ state: "verifyFailed", releaseId: RELEASE, stage: "sha256" });
    q.enqueueNativeState({ state: "downloading", releaseId: RELEASE });
    expect(q.size).toBe(2);
  });
});
