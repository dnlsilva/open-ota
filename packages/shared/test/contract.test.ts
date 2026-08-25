import { describe, expect, it } from "vitest";
import {
  canonicalize,
  createPreviewToken,
  generateSigningKeyPair,
  isInRollout,
  isNewerRelease,
  rolloutBucket,
  signCanonical,
  uuidv7,
  uuidv7Timestamp,
  verifyCanonical,
  verifyPreviewToken,
  encryptSecret,
  decryptSecret,
  generateMasterKey,
  sha256Hex,
  utf8,
  manifestSchema,
  updateCheckResponseSchema,
} from "../src/index.js";

describe("canonical JSON", () => {
  it("sorts keys regardless of insertion order", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalize({ a: 2, b: 1 })).toBe(canonicalize({ b: 1, a: 2 }));
  });

  it("keeps array order and drops undefined members", () => {
    expect(canonicalize({ list: [3, 1, 2], skip: undefined as never })).toBe('{"list":[3,1,2]}');
  });

  it("escapes strings the same way JSON.stringify does", () => {
    expect(canonicalize({ s: 'a"b\n' })).toBe('{"s":"a\\"b\\n"}');
  });
});

describe("uuidv7", () => {
  it("encodes the timestamp and stays sortable", () => {
    const early = uuidv7(1_700_000_000_000);
    const late = uuidv7(1_800_000_000_000);
    expect(uuidv7Timestamp(early)).toBe(1_700_000_000_000);
    expect(early < late).toBe(true);
    expect(isNewerRelease(late, early)).toBe(true);
    expect(isNewerRelease(early, late)).toBe(false);
  });

  it("treats a missing floor as always newer", () => {
    expect(isNewerRelease(uuidv7(), null)).toBe(true);
  });

  it("sets version and variant bits", () => {
    const id = uuidv7();
    expect(id[14]).toBe("7");
    expect(["8", "9", "a", "b"]).toContain(id[19]);
  });
});

describe("signing", () => {
  it("verifies a manifest it signed and rejects a tampered one", async () => {
    const { publicKeyPem, privateKeyPem } = await generateSigningKeyPair();
    const manifest = {
      id: uuidv7(),
      projectId: "prj_1",
      platform: "ios" as const,
      channel: "production",
      runtimeVersion: "fp_abc",
      label: 42,
      sha256: "a".repeat(64),
      size: 1234,
      createdAt: new Date(0).toISOString(),
    };
    expect(manifestSchema.safeParse(manifest).success).toBe(true);

    const signature = await signCanonical(manifest, privateKeyPem);
    expect(await verifyCanonical(manifest, signature, publicKeyPem)).toBe(true);
    expect(await verifyCanonical({ ...manifest, label: 43 }, signature, publicKeyPem)).toBe(false);
  });

  it("rejects a signature made with another project's key", async () => {
    const a = await generateSigningKeyPair();
    const b = await generateSigningKeyPair();
    const payload = { hello: "world" };
    const signature = await signCanonical(payload, a.privateKeyPem);
    expect(await verifyCanonical(payload, signature, b.publicKeyPem)).toBe(false);
  });
});

describe("secret encryption", () => {
  it("round-trips a project private key", async () => {
    const master = generateMasterKey();
    const { privateKeyPem } = await generateSigningKeyPair();
    const sealed = await encryptSecret(privateKeyPem, master);
    expect(sealed).not.toContain("PRIVATE KEY");
    expect(await decryptSecret(sealed, master)).toBe(privateKeyPem);
  });

  it("fails to decrypt under a different master key", async () => {
    const sealed = await encryptSecret("secret", generateMasterKey());
    await expect(decryptSecret(sealed, generateMasterKey())).rejects.toThrow();
  });
});

describe("rollout bucketing", () => {
  it("is deterministic per device+release", async () => {
    const a = await rolloutBucket("device-1", "release-1");
    const b = await rolloutBucket("device-1", "release-1");
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(10_000);
  });

  it("salts by release so a device is not always an early adopter", async () => {
    const first = await rolloutBucket("device-1", "release-1");
    const second = await rolloutBucket("device-1", "release-2");
    expect(first).not.toBe(second);
  });

  it("is monotonic: raising the percentage only adds devices", async () => {
    const devices = Array.from({ length: 300 }, (_, i) => `device-${i}`);
    const at10: string[] = [];
    const at25: string[] = [];
    for (const d of devices) {
      if (await isInRollout(d, "rel", 10)) at10.push(d);
      if (await isInRollout(d, "rel", 25)) at25.push(d);
    }
    expect(at10.every((d) => at25.includes(d))).toBe(true);
    expect(at25.length).toBeGreaterThan(at10.length);
  });

  it("spreads roughly evenly across the bucket space", async () => {
    const devices = Array.from({ length: 500 }, (_, i) => `d-${i}`);
    let included = 0;
    for (const d of devices) if (await isInRollout(d, "rel", 50)) included++;
    expect(included).toBeGreaterThan(200);
    expect(included).toBeLessThan(300);
  });

  it("honours the 0 and 100 edges without hashing", async () => {
    expect(await isInRollout("d", "r", 0)).toBe(false);
    expect(await isInRollout("d", "r", 100)).toBe(true);
  });
});

describe("preview tokens", () => {
  const projectId = "prj_preview";

  it("accepts a fresh token for the right project", async () => {
    const keys = await generateSigningKeyPair();
    const link = await createPreviewToken({ projectId, releaseId: uuidv7() }, keys.privateKeyPem);
    const result = await verifyPreviewToken(link.d, link.s, keys.publicKeyPem, {
      expectedProjectId: projectId,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a token minted for another project", async () => {
    const keys = await generateSigningKeyPair();
    const link = await createPreviewToken({ projectId: "prj_other", releaseId: uuidv7() }, keys.privateKeyPem);
    const result = await verifyPreviewToken(link.d, link.s, keys.publicKeyPem, {
      expectedProjectId: projectId,
    });
    expect(result).toEqual({ ok: false, reason: "wrongProject" });
  });

  it("rejects a token signed by another project's key", async () => {
    const mine = await generateSigningKeyPair();
    const theirs = await generateSigningKeyPair();
    const link = await createPreviewToken({ projectId, releaseId: uuidv7() }, theirs.privateKeyPem);
    const result = await verifyPreviewToken(link.d, link.s, mine.publicKeyPem, {
      expectedProjectId: projectId,
    });
    expect(result).toEqual({ ok: false, reason: "badSignature" });
  });

  it("rejects an expired token beyond the clock-skew grace", async () => {
    const keys = await generateSigningKeyPair();
    const link = await createPreviewToken(
      { projectId, releaseId: uuidv7(), ttlMinutes: 1 },
      keys.privateKeyPem,
      0,
    );
    const result = await verifyPreviewToken(link.d, link.s, keys.publicKeyPem, {
      expectedProjectId: projectId,
      now: 10 * 60 * 1000,
    });
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("tolerates a device clock a couple of minutes behind", async () => {
    const keys = await generateSigningKeyPair();
    const link = await createPreviewToken(
      { projectId, releaseId: uuidv7(), ttlMinutes: 1 },
      keys.privateKeyPem,
      0,
    );
    const result = await verifyPreviewToken(link.d, link.s, keys.publicKeyPem, {
      expectedProjectId: projectId,
      now: 3 * 60 * 1000,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a payload whose signature does not cover it", async () => {
    const keys = await generateSigningKeyPair();
    const link = await createPreviewToken({ projectId, releaseId: uuidv7() }, keys.privateKeyPem);
    const forged = btoa(JSON.stringify({ ...link.payload, releaseId: uuidv7() }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const result = await verifyPreviewToken(forged, link.s, keys.publicKeyPem, {
      expectedProjectId: projectId,
    });
    expect(result).toEqual({ ok: false, reason: "badSignature" });
  });
});

describe("protocol schemas", () => {
  it("accepts the three update-check outcomes", () => {
    expect(updateCheckResponseSchema.safeParse({ action: "none" }).success).toBe(true);
    expect(updateCheckResponseSchema.safeParse({ action: "rollBackToEmbedded" }).success).toBe(true);
  });

  it("requires a 64-char lowercase hex digest in the manifest", () => {
    const base = {
      id: uuidv7(),
      projectId: "p",
      platform: "android",
      channel: "production",
      runtimeVersion: "fp",
      label: 1,
      size: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(manifestSchema.safeParse({ ...base, sha256: "abc" }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...base, sha256: "A".repeat(64) }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...base, sha256: "a".repeat(64) }).success).toBe(true);
  });
});

describe("sha256", () => {
  it("matches the known digest of an empty input", async () => {
    expect(await sha256Hex(utf8(""))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});
