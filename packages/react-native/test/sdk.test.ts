import { describe, expect, it } from "vitest";
import { createPreviewToken, generateSigningKeyPair, uuidv7 } from "@open-ota/shared";
import { handlePreviewRequest, parsePreviewLink, type PreviewDeps } from "../src/preview.js";
import { isNativeModuleAvailable, nativeModule } from "../src/native.js";

describe("importing without a native module", () => {
  it("loads in Node and only fails when a method is actually called", async () => {
    const sdk = await import("../src/index.js");
    expect(typeof sdk.OpenOta.sync).toBe("function");
    expect(typeof sdk.OpenOta.wrap).toBe("function");
    expect(isNativeModuleAvailable()).toBe(false);
    expect(() => nativeModule().reload()).toThrow(/native module not found/i);
  });
});

describe("preview deep link", () => {
  const projectId = "prj_preview";
  const runtimeVersion = "fp_9f8e7d";

  function deps(overrides: Partial<PreviewDeps> & Pick<PreviewDeps, "publicKey">): PreviewDeps {
    return {
      apiUrl: "https://ota.example.com",
      appKey: "pk_1",
      projectId,
      runtimeVersion,
      install: async () => undefined,
      ...overrides,
    };
  }

  function manifestResponse(releaseId: string, runtime = runtimeVersion) {
    return {
      manifest: {
        id: releaseId,
        projectId,
        platform: "ios",
        channel: "production",
        runtimeVersion: runtime,
        label: 42,
        sha256: "c".repeat(64),
        size: 10,
        createdAt: "2026-09-01T12:00:00Z",
      },
      signature: "sig",
      url: "https://cdn.example.com/b.zip",
    };
  }

  function fetchReturning(body: unknown): typeof globalThis.fetch {
    return (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof globalThis.fetch;
  }

  it("splits d and s out of the deep link the OS delivered", () => {
    expect(parsePreviewLink({ url: "myapp://ota/preview?d=AAA&s=BBB" })).toEqual({ d: "AAA", s: "BBB" });
    expect(parsePreviewLink({ d: "AAA", s: "BBB" })).toEqual({ d: "AAA", s: "BBB" });
    expect(parsePreviewLink({ url: "myapp://ota/preview" })).toBeNull();
  });

  it("installs a release signed by this project", async () => {
    const keys = await generateSigningKeyPair();
    const releaseId = uuidv7();
    const link = await createPreviewToken({ projectId, releaseId }, keys.privateKeyPem);
    const installed: string[] = [];

    const result = await handlePreviewRequest(link, {
      ...deps({ publicKey: keys.publicKeyPem }),
      fetchImpl: fetchReturning(manifestResponse(releaseId)),
      install: async (manifestJson) => {
        installed.push(manifestJson);
      },
    });

    expect(result).toEqual({ ok: true, release: { id: releaseId, label: 42 } });
    expect(JSON.parse(installed[0] ?? "{}")).toMatchObject({ id: releaseId });
  });

  it("accepts the bare base64 key the config plugin embeds", async () => {
    const keys = await generateSigningKeyPair();
    const releaseId = uuidv7();
    const link = await createPreviewToken({ projectId, releaseId }, keys.privateKeyPem);
    const stripped = keys.publicKeyPem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");

    const result = await handlePreviewRequest(link, {
      ...deps({ publicKey: stripped }),
      fetchImpl: fetchReturning(manifestResponse(releaseId)),
    });
    expect(result.ok).toBe(true);
  });

  it("never reaches the network for a token signed by another key", async () => {
    const mine = await generateSigningKeyPair();
    const theirs = await generateSigningKeyPair();
    const link = await createPreviewToken({ projectId, releaseId: uuidv7() }, theirs.privateKeyPem);
    let called = false;

    const result = await handlePreviewRequest(link, {
      ...deps({ publicKey: mine.publicKeyPem }),
      fetchImpl: (async () => {
        called = true;
        return { ok: true, status: 200, json: async () => ({}) };
      }) as unknown as typeof globalThis.fetch,
    });

    expect(result).toMatchObject({ ok: false, reason: "badSignature" });
    expect(called).toBe(false);
  });

  it("refuses a release built for a different native runtime, with the runtime named", async () => {
    const keys = await generateSigningKeyPair();
    const releaseId = uuidv7();
    const link = await createPreviewToken({ projectId, releaseId }, keys.privateKeyPem);

    const result = await handlePreviewRequest(link, {
      ...deps({ publicKey: keys.publicKeyPem }),
      fetchImpl: fetchReturning(manifestResponse(releaseId, "fp_other")),
    });

    expect(result).toMatchObject({ ok: false, reason: "incompatibleRuntime" });
    if (!result.ok) expect(result.message).toContain("fp_other");
  });
});
