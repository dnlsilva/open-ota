import { describe, expect, it } from "vitest";
import { MAX_FAILED_RELEASES, type UpdateCheckResponse } from "@open-ota/shared";
import { buildUpdateCheckUrl, planFrom, updateCheckHeaders } from "../src/OpenOta.js";
import type { OtaStatus } from "../src/types.js";

const RUNTIME = "fp_9f8e7d";
const CURRENT = "0193a4c8-0000-7000-8000-000000000001";
const NEXT = "0193a4c8-0000-7000-8000-000000000002";

function status(overrides: Partial<OtaStatus> = {}): OtaStatus {
  return {
    deviceId: "3f7a1111",
    channel: "production",
    runtimeVersion: RUNTIME,
    nativeVersion: "1.4.2",
    currentRelease: null,
    pendingRelease: null,
    failedReleases: [],
    isPreview: false,
    ...overrides,
  };
}

function update(
  overrides: { mandatory?: boolean; manifest?: Record<string, unknown> } = {},
): UpdateCheckResponse {
  return {
    action: "update",
    mandatory: overrides.mandatory ?? false,
    manifest: {
      id: NEXT,
      projectId: "prj_1",
      platform: "android",
      channel: "production",
      runtimeVersion: RUNTIME,
      label: 42,
      sha256: "b".repeat(64),
      size: 100,
      createdAt: "2026-09-01T12:00:00Z",
      ...overrides.manifest,
    },
    signature: "sig",
    url: "https://cdn.example.com/b.zip",
  } as UpdateCheckResponse;
}

describe("update-check request", () => {
  it("sends the four required parameters and drops the empty optionals", () => {
    const url = buildUpdateCheckUrl("https://ota.example.com/", {
      platform: "android",
      channel: "production",
      runtime: RUNTIME,
      device: "3f7a",
    });
    expect(url).toBe(
      "https://ota.example.com/api/v1/update-check" +
        "?platform=android&channel=production&runtime=fp_9f8e7d&device=3f7a",
    );
  });

  it("carries current, floor, native version and failed releases", () => {
    const url = buildUpdateCheckUrl("https://ota.example.com", {
      platform: "ios",
      channel: "staging",
      runtime: RUNTIME,
      device: "d1",
      current: CURRENT,
      floor: "0193a000-0000-7000-8000-000000000000",
      native: "1.4.2",
      failed: [NEXT],
    });
    expect(url).toContain(`&current=${CURRENT}`);
    expect(url).toContain("&floor=0193a000-0000-7000-8000-000000000000");
    expect(url).toContain("&native=1.4.2");
    expect(url).toContain(`&failed=${NEXT}`);
  });

  it("percent-encodes channel names", () => {
    const url = buildUpdateCheckUrl("https://ota.example.com", {
      platform: "ios",
      channel: "qa/eu west",
      runtime: RUNTIME,
      device: "d1",
    });
    expect(url).toContain("channel=qa%2Feu%20west");
  });

  it("caps the failed list at the protocol maximum, keeping the most recent", () => {
    const failed = Array.from({ length: 25 }, (_, i) => `rel-${i}`);
    const url = buildUpdateCheckUrl("https://ota.example.com", {
      platform: "android",
      channel: "production",
      runtime: RUNTIME,
      device: "d1",
      failed,
    });
    const sent = decodeURIComponent(url.split("failed=")[1] ?? "").split(",");
    expect(sent).toHaveLength(MAX_FAILED_RELEASES);
    expect(sent[MAX_FAILED_RELEASES - 1]).toBe("rel-24");
    expect(sent).not.toContain("rel-0");
  });

  it("identifies the project with the public app key header", () => {
    expect(updateCheckHeaders("pk_a1b2")).toMatchObject({ "x-ota-app-key": "pk_a1b2" });
    expect(updateCheckHeaders("pk_a1b2")["x-ota-sdk-version"]).toBeTruthy();
  });
});

describe("update-check decision", () => {
  it("does nothing on action none", () => {
    expect(planFrom({ action: "none" }, status(), RUNTIME)).toEqual({ action: "none" });
  });

  it("rolls back to embedded when a release is running", () => {
    const plan = planFrom(
      { action: "rollBackToEmbedded" },
      status({ currentRelease: { id: CURRENT, label: 41 } }),
      RUNTIME,
    );
    expect(plan).toEqual({ action: "rollBackToEmbedded" });
  });

  it("ignores rollBackToEmbedded when already on the embedded bundle", () => {
    expect(planFrom({ action: "rollBackToEmbedded" }, status(), RUNTIME)).toEqual({ action: "none" });
  });

  it("downloads an update and defers the reload when it is not mandatory", () => {
    const plan = planFrom(update(), status(), RUNTIME);
    expect(plan).toMatchObject({ action: "download", reload: false });
  });

  it("reloads immediately for a mandatory update", () => {
    const plan = planFrom(update({ mandatory: true }), status(), RUNTIME);
    expect(plan).toMatchObject({ action: "download", reload: true });
  });

  it("skips a release that is already running or already staged", () => {
    expect(
      planFrom(update(), status({ currentRelease: { id: NEXT, label: 42 } }), RUNTIME),
    ).toEqual({ action: "none" });
    expect(
      planFrom(update(), status({ pendingRelease: { id: NEXT, label: 42 } }), RUNTIME),
    ).toEqual({ action: "none" });
  });

  it("refuses a manifest built for another native runtime", () => {
    const plan = planFrom(update({ manifest: { runtimeVersion: "fp_other" } }), status(), RUNTIME);
    expect(plan).toEqual({ action: "incompatible", runtimeVersion: "fp_other" });
  });
});
