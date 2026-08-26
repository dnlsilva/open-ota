/**
 * The update-check policy is the single most consequential piece of logic in
 * the platform: it decides what every installed app runs. These cover the
 * cases that would ship a broken build to users, or strand them on one.
 */

import { uuidv7 } from "@open-ota/shared";
import { describe, expect, it } from "vitest";
import { decideTarget, type CandidateRelease } from "../src/services/releases.js";

let clock = 1_700_000_000_000;
function release(overrides: Partial<CandidateRelease> = {}): CandidateRelease {
  clock += 1000;
  return {
    id: uuidv7(clock),
    status: "active",
    rolloutPercent: 100,
    mandatory: false,
    storageKey: "bundles/x.zip",
    ...overrides,
  };
}

const DEVICE = "device-abc";
const query = (over: Partial<Parameters<typeof decideTarget>[1]> = {}) => ({
  device: DEVICE,
  failed: [] as string[],
  ...over,
});

describe("decideTarget", () => {
  it("offers the newest release to a device on the embedded bundle", async () => {
    const older = release();
    const newer = release();
    const result = await decideTarget([newer, older], query());
    expect(result).toEqual({ action: "update", target: newer });
  });

  it("says nothing when the device already runs the newest release", async () => {
    const current = release();
    expect(await decideTarget([current], query({ current: current.id }))).toEqual({ action: "none" });
  });

  it("never offers a release older than the bundle baked into the binary", async () => {
    const stale = release();
    const floor = uuidv7(clock + 5_000);
    expect(await decideTarget([stale], query({ floor }))).toEqual({ action: "none" });
  });

  it("offers a release published after the binary was built", async () => {
    const floor = uuidv7(clock);
    const fresh = release();
    expect(await decideTarget([fresh], query({ floor }))).toEqual({ action: "update", target: fresh });
  });

  it("skips a release this device already failed and falls back to the previous one", async () => {
    const good = release();
    const broken = release();
    const result = await decideTarget([broken, good], query({ failed: [broken.id] }));
    expect(result).toEqual({ action: "update", target: good });
  });

  it("keeps a device on a paused release it already installed", async () => {
    const paused = release({ status: "paused" });
    expect(await decideTarget([paused], query({ current: paused.id }))).toEqual({ action: "none" });
  });

  it("does not hand a paused release to a device that lacks it", async () => {
    const paused = release({ status: "paused" });
    expect(await decideTarget([paused], query())).toEqual({ action: "none" });
  });

  it("walks a device back when the release it runs was disabled", async () => {
    // A disabled release is excluded by the query, so it is simply absent here.
    const previous = release();
    const result = await decideTarget([previous], query({ current: uuidv7(clock + 10_000) }));
    expect(result).toEqual({ action: "update", target: previous });
  });

  it("returns to the embedded bundle when nothing is left to run", async () => {
    expect(await decideTarget([], query({ current: uuidv7() }))).toEqual({ action: "rollBackToEmbedded" });
  });

  it("stays quiet for a fresh install with no releases at all", async () => {
    expect(await decideTarget([], query())).toEqual({ action: "none" });
  });

  it("falls through a partial rollout to an older fully-released version", async () => {
    const full = release({ rolloutPercent: 100 });
    const canary = release({ rolloutPercent: 0 });
    const result = await decideTarget([canary, full], query());
    expect(result).toEqual({ action: "update", target: full });
  });

  it("gives a device inside the rollout the newer release", async () => {
    const full = release({ rolloutPercent: 100 });
    const canary = release({ rolloutPercent: 100 });
    const result = await decideTarget([canary, full], query());
    expect(result).toEqual({ action: "update", target: canary });
  });

  it("keeps a device that already installed a canary on it when the rollout is small", async () => {
    const canary = release({ rolloutPercent: 1 });
    expect(await decideTarget([canary], query({ current: canary.id }))).toEqual({ action: "none" });
  });

  it("carries the mandatory flag of the release it selects", async () => {
    const urgent = release({ mandatory: true });
    const result = await decideTarget([urgent], query());
    expect(result).toEqual({ action: "update", target: urgent });
    expect(result.action === "update" && result.target.mandatory).toBe(true);
  });

  it("ignores every failed release and reports back to embedded when all are broken", async () => {
    const a = release();
    const b = release();
    const result = await decideTarget([b, a], query({ current: a.id, failed: [a.id, b.id] }));
    expect(result).toEqual({ action: "rollBackToEmbedded" });
  });

  it("is stable: the same device and inputs always get the same answer", async () => {
    const rows = [release({ rolloutPercent: 37 }), release({ rolloutPercent: 100 })];
    const first = await decideTarget(rows, query());
    const second = await decideTarget(rows, query());
    expect(first).toEqual(second);
  });

  it("splits a partial rollout across devices instead of giving it to everyone", async () => {
    const canary = release({ rolloutPercent: 20 });
    const stable = release({ rolloutPercent: 100 });
    const rows = [canary, stable];

    let onCanary = 0;
    for (let i = 0; i < 200; i++) {
      const result = await decideTarget(rows, { device: `device-${i}`, failed: [] });
      if (result.action === "update" && result.target.id === canary.id) onCanary++;
    }
    expect(onCanary).toBeGreaterThan(10);
    expect(onCanary).toBeLessThan(70);
  });
});
