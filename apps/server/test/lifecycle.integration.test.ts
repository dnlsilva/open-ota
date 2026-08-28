/**
 * End-to-end over a real Postgres engine: publish, check, install, roll out,
 * promote, break a release and watch devices land back on the previous one.
 * If the spine of the product breaks, this file is where it shows.
 */

import {
  createPreviewToken,
  decryptSecret,
  sha256Hex,
  utf8,
  verifyCanonical,
  verifyPreviewToken,
  type EventsRequest,
  type UpdateCheckQuery,
} from "@open-ota/shared";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { orgs, users } from "../src/db/schema.js";
import { getDistribution, getReleaseMetrics } from "../src/services/metrics.js";
import { createProject } from "../src/services/projects.js";
import {
  confirmRelease,
  prepareUpload,
  promoteRelease,
  requireProject,
  resolveUpdate,
  rollbackRelease,
  updateRelease,
} from "../src/services/releases.js";
import { recordEvents, touchDevice } from "../src/services/telemetry.js";
import { createTestHarness, type TestHarness } from "./helpers/testServer.js";
import { uuidv7 } from "@open-ota/shared";

const RUNTIME = "fp_9f8e7d6c";
const BUNDLE = utf8("PK pretend this is a hermes bundle");

let h: TestHarness;
let orgId: string;
let projectId: string;

beforeEach(async () => {
  h = await createTestHarness();
  orgId = uuidv7();
  const userId = uuidv7();
  await h.ctx.db.insert(users).values({ id: userId, email: "dev@test.local", passwordHash: "x" });
  await h.ctx.db.insert(orgs).values({ id: orgId, name: "Test", slug: "test", planId: "free" });
  const project = await createProject(h.ctx, { orgId, name: "Demo App", deepLinkScheme: "demoapp" });
  projectId = project.id;
});

afterEach(async () => {
  await h.close();
});

/** The three-step publish the CLI performs. */
async function publish(
  opts: { channel?: string; rolloutPercent?: number; mandatory?: boolean; body?: Uint8Array } = {},
) {
  const body = opts.body ?? BUNDLE;
  const sha256 = await sha256Hex(body);
  const prepared = await prepareUpload(h.ctx, {
    projectId,
    platform: "android",
    channel: opts.channel ?? "production",
    runtimeVersion: RUNTIME,
    sha256,
    size: body.length,
    rolloutPercent: opts.rolloutPercent,
    mandatory: opts.mandatory,
  });
  h.storage.upload(prepared.storageKey, body);
  return confirmRelease(h.ctx, prepared.releaseId);
}

function check(over: Partial<UpdateCheckQuery> = {}): UpdateCheckQuery {
  return {
    platform: "android",
    channel: "production",
    runtime: RUNTIME,
    device: "device-1",
    native: "1.4.2",
    failed: [],
    ...over,
  } as UpdateCheckQuery;
}

describe("release lifecycle", () => {
  it("publishes a release and offers it to a device on the embedded bundle", async () => {
    const release = await publish();
    expect(release.status).toBe("active");
    expect(release.label).toBe(1);

    const project = await requireProject(h.ctx, projectId);
    const result = await resolveUpdate(h.ctx, project, check());

    expect(result.action).toBe("update");
    if (result.action !== "update") return;
    expect(result.manifest.label).toBe(1);
    expect(result.manifest.sha256).toBe(await sha256Hex(BUNDLE));
    expect(result.url).toContain(release.storageKey);
  });

  it("signs the manifest with the project key so the device can verify it", async () => {
    await publish();
    const project = await requireProject(h.ctx, projectId);
    const result = await resolveUpdate(h.ctx, project, check());
    if (result.action !== "update") throw new Error("expected an update");

    expect(await verifyCanonical(result.manifest, result.signature, project.publicKey)).toBe(true);
    // The URL is not signed on purpose, so a CDN move does not invalidate it.
    const tampered = { ...result.manifest, sha256: "b".repeat(64) };
    expect(await verifyCanonical(tampered, result.signature, project.publicKey)).toBe(false);
  });

  it("refuses to confirm a bundle whose bytes do not match the declared digest", async () => {
    const prepared = await prepareUpload(h.ctx, {
      projectId,
      platform: "android",
      channel: "production",
      runtimeVersion: RUNTIME,
      sha256: await sha256Hex(BUNDLE),
      size: BUNDLE.length,
    });

    // Same length, different bytes — so this exercises the digest check rather
    // than tripping the cheaper size comparison first.
    const swapped = new Uint8Array(BUNDLE);
    swapped[0] = swapped[0]! ^ 0xff;
    h.storage.upload(prepared.storageKey, swapped);

    await expect(confirmRelease(h.ctx, prepared.releaseId)).rejects.toThrow(/does not match the declared sha256/i);

    const row = await h.ctx.db.query.releases.findFirst();
    expect(row?.status).toBe("pending");
  });

  it("rejects a bundle that arrives at the wrong size", async () => {
    const prepared = await prepareUpload(h.ctx, {
      projectId,
      platform: "android",
      channel: "production",
      runtimeVersion: RUNTIME,
      sha256: await sha256Hex(BUNDLE),
      size: BUNDLE.length,
    });
    h.storage.upload(prepared.storageKey, utf8("truncated"));
    await expect(confirmRelease(h.ctx, prepared.releaseId)).rejects.toThrow(/bytes/i);
  });

  it("does not offer a release built for a different native runtime", async () => {
    await publish();
    const project = await requireProject(h.ctx, projectId);
    const result = await resolveUpdate(h.ctx, project, check({ runtime: "fp_after_a_native_change" }));
    expect(result.action).toBe("none");
  });

  it("numbers labels per channel and keeps the bundle when promoting", async () => {
    const staging = await publish({ channel: "staging" });
    const promoted = await promoteRelease(h.ctx, staging.id, "production");

    expect(promoted.label).toBe(1);
    expect(promoted.id).not.toBe(staging.id);
    // Promotion must not re-upload: same object, same digest.
    expect(promoted.storageKey).toBe(staging.storageKey);
    expect(promoted.sha256).toBe(staging.sha256);
    expect(promoted.signature).not.toBe(staging.signature);

    const second = await publish({ channel: "staging" });
    expect(second.label).toBe(2);
  });

  it("walks devices back to the previous release when the current one is disabled", async () => {
    const first = await publish();
    const second = await publish();
    const project = await requireProject(h.ctx, projectId);

    const before = await resolveUpdate(h.ctx, project, check({ current: first.id }));
    expect(before.action === "update" && before.manifest.id).toBe(second.id);

    const { target } = await rollbackRelease(h.ctx, second.id);
    expect(target?.id).toBe(first.id);

    const after = await resolveUpdate(h.ctx, project, check({ current: second.id }));
    expect(after.action).toBe("update");
    if (after.action === "update") expect(after.manifest.id).toBe(first.id);
  });

  it("sends a device back to the embedded bundle when every release is disabled", async () => {
    const only = await publish();
    await updateRelease(h.ctx, only.id, { status: "disabled" });
    const project = await requireProject(h.ctx, projectId);

    const result = await resolveUpdate(h.ctx, project, check({ current: only.id }));
    expect(result.action).toBe("rollBackToEmbedded");
  });

  it("keeps a device on a paused release but stops handing it to new ones", async () => {
    const release = await publish();
    await updateRelease(h.ctx, release.id, { status: "paused" });
    const project = await requireProject(h.ctx, projectId);

    expect((await resolveUpdate(h.ctx, project, check({ current: release.id }))).action).toBe("none");
    expect((await resolveUpdate(h.ctx, project, check({ device: "fresh-device" }))).action).toBe("none");
  });

  it("never offers a bundle older than the one inside the binary", async () => {
    const old = await publish();
    const project = await requireProject(h.ctx, projectId);
    const laterBuild = uuidv7(Date.now() + 60_000);

    const result = await resolveUpdate(h.ctx, project, check({ floor: laterBuild }));
    expect(result.action).toBe("none");
    expect(old.id < laterBuild).toBe(true);
  });
});

describe("telemetry", () => {
  it("counts a device once and only rewrites the row when something changes", async () => {
    const release = await publish();
    const touch = {
      deviceId: "device-1",
      projectId,
      platform: "android" as const,
      channel: "production",
      nativeVersion: "1.4.2",
      runtimeVersion: RUNTIME,
      currentReleaseId: null as string | null,
    };

    await touchDevice(h.ctx, touch);
    const first = await h.ctx.db.query.devices.findFirst();
    expect(first?.currentReleaseId).toBeNull();

    // Same state a minute later: the throttle keeps the write away.
    h.setNow(new Date("2026-08-27T12:01:00.000Z"));
    await touchDevice(h.ctx, touch);
    const unchanged = await h.ctx.db.query.devices.findFirst();
    expect(unchanged?.lastSeenAt).toEqual(first?.lastSeenAt);

    // Installing an update is a change, so it lands immediately.
    await touchDevice(h.ctx, { ...touch, currentReleaseId: release.id });
    const moved = await h.ctx.db.query.devices.findFirst();
    expect(moved?.currentReleaseId).toBe(release.id);
  });

  it("builds the funnel and the rollback rate from event batches", async () => {
    const release = await publish();
    const events: EventsRequest = {
      device: "device-1",
      platform: "android",
      native: "1.4.2",
      events: [
        { type: "download", release: release.id, ts: 1 },
        { type: "install", release: release.id, ts: 2 },
        { type: "ready", release: release.id, ts: 3 },
      ],
    };
    await recordEvents(h.ctx, projectId, events);
    await recordEvents(h.ctx, projectId, {
      ...events,
      device: "device-2",
      events: [
        { type: "install", release: release.id, ts: 4 },
        { type: "rollback", release: release.id, ts: 5, meta: { reason: "crash" } },
      ],
    });

    const metrics = await getReleaseMetrics(h.ctx, release.id);
    expect(metrics.installs).toBe(2);
    expect(metrics.ready).toBe(1);
    expect(metrics.rollbacks).toBe(1);
    expect(metrics.successRate).toBe(50);
    expect(metrics.rollbackRate).toBe(50);
    expect(metrics.daily).toHaveLength(1);
  });

  it("ignores events naming a release from another project", async () => {
    const release = await publish();
    const foreign = uuidv7();
    await recordEvents(h.ctx, projectId, {
      device: "device-1",
      events: [
        { type: "ready", release: foreign, ts: 1 },
        { type: "ready", release: release.id, ts: 2 },
      ],
    });

    const metrics = await getReleaseMetrics(h.ctx, release.id);
    expect(metrics.ready).toBe(1);
  });

  it("reports the version distribution the dashboard table is built from", async () => {
    const v1 = await publish();
    const v2 = await publish();

    for (const [device, releaseId] of [
      ["d1", v2.id],
      ["d2", v2.id],
      ["d3", v1.id],
      ["d4", null],
    ] as const) {
      await touchDevice(h.ctx, {
        deviceId: device,
        projectId,
        platform: "android",
        channel: "production",
        nativeVersion: "1.4.2",
        runtimeVersion: RUNTIME,
        currentReleaseId: releaseId,
      });
    }

    const dist = await getDistribution(h.ctx, projectId);
    expect(dist.totalDevices).toBe(4);
    const onV2 = dist.releases.find((r) => r.releaseId === v2.id);
    expect(onV2?.devices).toBe(2);
    expect(onV2?.percentOfBase).toBe(50);
    // Devices still on the embedded bundle are part of the base, not hidden.
    expect(dist.releases.find((r) => r.releaseId === null)?.devices).toBe(1);
    expect(dist.nativeVersions[0]?.nativeVersion).toBe("1.4.2");
  });
});

describe("preview links", () => {
  it("round-trips a signed link for the right project and refuses another one", async () => {
    const release = await publish();
    const project = await requireProject(h.ctx, projectId);
    const privateKeyPem = await decryptSecret(project.privateKeyEnc, h.ctx.config.OTA_MASTER_KEY);

    const link = await createPreviewToken(
      { projectId, releaseId: release.id },
      privateKeyPem,
      h.ctx.now().getTime(),
    );

    const good = await verifyPreviewToken(link.d, link.s, project.publicKey, {
      expectedProjectId: projectId,
      now: h.ctx.now().getTime(),
    });
    expect(good.ok).toBe(true);

    const other = await createProject(h.ctx, { orgId, name: "Other App" });
    const bad = await verifyPreviewToken(link.d, link.s, other.publicKey, {
      expectedProjectId: other.id,
      now: h.ctx.now().getTime(),
    });
    expect(bad.ok).toBe(false);
  });
});
