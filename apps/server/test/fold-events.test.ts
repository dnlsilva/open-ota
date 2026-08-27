import type { EventsRequest } from "@open-ota/shared";
import { uuidv7 } from "@open-ota/shared";
import { describe, expect, it } from "vitest";
import { foldEvents } from "../src/services/telemetry.js";

const DAY = "2026-08-27";
const RELEASE = uuidv7();
const OTHER = uuidv7();

function batch(events: EventsRequest["events"], over: Partial<EventsRequest> = {}): EventsRequest {
  return { device: "device-1", platform: "android", native: "1.4.2", events, ...over };
}

const ev = (type: EventsRequest["events"][number]["type"], release = RELEASE, meta?: object) =>
  ({ type, release, ts: 1, ...(meta ? { meta } : {}) }) as EventsRequest["events"][number];

describe("foldEvents", () => {
  const owned = new Set([RELEASE]);

  it("collapses a batch into one row per release", () => {
    const { counters } = foldEvents(
      batch([ev("download"), ev("install"), ev("ready")]),
      owned,
      DAY,
    );
    expect(counters).toEqual([
      { releaseId: RELEASE, day: DAY, downloads: 1, installs: 1, ready: 1, failed: 0, rollbacks: 0 },
    ]);
  });

  it("sums repeated events of the same type", () => {
    const { counters } = foldEvents(batch([ev("download"), ev("download"), ev("download")]), owned, DAY);
    expect(counters[0]?.downloads).toBe(3);
  });

  it("counts a rollback as both a rollback and a failure, so the funnel adds up", () => {
    const { counters } = foldEvents(batch([ev("install"), ev("rollback")]), owned, DAY);
    expect(counters[0]).toMatchObject({ installs: 1, rollbacks: 1, failed: 1 });
  });

  it("drops events for releases that belong to another project", () => {
    const { counters } = foldEvents(batch([ev("ready", OTHER), ev("ready")]), owned, DAY);
    expect(counters).toHaveLength(1);
    expect(counters[0]?.releaseId).toBe(RELEASE);
    expect(counters[0]?.ready).toBe(1);
  });

  it("returns nothing when every event is foreign", () => {
    const { counters, rollbacks } = foldEvents(batch([ev("ready", OTHER)]), owned, DAY);
    expect(counters).toEqual([]);
    expect(rollbacks).toEqual([]);
  });

  it("keeps the reason and the previous release on a rollback record", () => {
    const from = uuidv7();
    const { rollbacks } = foldEvents(
      batch([ev("rollback", RELEASE, { reason: "crash", from })]),
      owned,
      DAY,
    );
    expect(rollbacks).toEqual([
      {
        releaseId: RELEASE,
        fromReleaseId: from,
        reason: "crash",
        meta: { platform: "android", nativeVersion: "1.4.2", message: undefined, stage: undefined },
      },
    ]);
  });

  it("defaults an unlabelled rollback to a crash", () => {
    const { rollbacks } = foldEvents(batch([ev("rollback")]), owned, DAY);
    expect(rollbacks[0]?.reason).toBe("crash");
  });

  it("records a failed integrity check without inventing a rollback", () => {
    const { counters, rollbacks } = foldEvents(
      batch([ev("verifyFailed", RELEASE, { stage: "sha256" })]),
      owned,
      DAY,
    );
    expect(counters[0]).toMatchObject({ failed: 1, rollbacks: 0 });
    expect(rollbacks).toEqual([]);
  });
});
