import { describe, expect, it } from "vitest";
import { sha256Hex, type OtaClient, type PrepareUploadRequest, type PrepareUploadResponse } from "@open-ota/shared";

import { publishArchive } from "../src/publish.js";
import { archiveOf } from "../src/zip.js";

interface Recorded {
  order: string[];
  prepare?: PrepareUploadRequest;
  upload?: { url: string; method: string; headers: Record<string, string>; body: Uint8Array };
  confirmed?: string;
}

function harness(prepared: Partial<PrepareUploadResponse> = {}) {
  const recorded: Recorded = { order: [] };

  const client = {
    async prepareUpload(_projectId: string, input: PrepareUploadRequest) {
      recorded.order.push("prepare");
      recorded.prepare = input;
      return {
        releaseId: "0193a4c8-0000-7000-8000-000000000001",
        uploadUrl: "https://storage.example/bundles/abc.zip?sig=1",
        uploadHeaders: { "content-type": "application/zip", "x-amz-checksum-sha256": "declared" },
        storageKey: "bundles/abc.zip",
        ...prepared,
      } satisfies PrepareUploadResponse;
    },
    async confirmRelease(releaseId: string) {
      recorded.order.push("confirm");
      recorded.confirmed = releaseId;
      return { release: { id: releaseId, label: 42 } };
    },
  } as unknown as OtaClient;

  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    recorded.order.push("upload");
    recorded.upload = {
      url: String(url),
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: init.body as Uint8Array,
    };
    return new Response(null, { status: 200 });
  }) as unknown as typeof globalThis.fetch;

  return { client, fetchImpl, recorded };
}

const params = {
  projectId: "prj_1",
  platform: "ios" as const,
  channel: "staging",
  runtimeVersion: "fp_abc123",
  apiUrl: "https://api.example",
  token: "ota_token",
};

describe("publish", () => {
  it("runs prepare, upload and confirm in that order", async () => {
    const { client, fetchImpl, recorded } = harness();
    const archive = await archiveOf([{ path: "index.js", data: Buffer.from("bundle") }]);

    await publishArchive({ ...params, client, fetchImpl, archive, rolloutPercent: 10, mandatory: true });

    expect(recorded.order).toEqual(["prepare", "upload", "confirm"]);
    expect(recorded.confirmed).toBe("0193a4c8-0000-7000-8000-000000000001");
    expect(recorded.prepare).toMatchObject({
      platform: "ios",
      channel: "staging",
      runtimeVersion: "fp_abc123",
      rolloutPercent: 10,
      mandatory: true,
      size: archive.bytes.length,
    });
  });

  it("uploads exactly the bytes it declared the digest of", async () => {
    const { client, fetchImpl, recorded } = harness();
    const archive = await archiveOf([{ path: "index.js", data: Buffer.from("bundle") }]);

    await publishArchive({ ...params, client, fetchImpl, archive });

    const uploaded = Buffer.from(recorded.upload?.body as Uint8Array);
    expect(await sha256Hex(uploaded)).toBe(recorded.prepare?.sha256);
    expect(uploaded.equals(archive.bytes)).toBe(true);
  });

  it("PUTs to the signed url replaying the returned headers, with no bearer token", async () => {
    const { client, fetchImpl, recorded } = harness();
    await publishArchive({ ...params, client, fetchImpl, archive: await archiveOf([{ path: "a", data: Buffer.from("a") }]) });

    expect(recorded.upload?.method).toBe("PUT");
    expect(recorded.upload?.url).toBe("https://storage.example/bundles/abc.zip?sig=1");
    expect(recorded.upload?.headers["x-amz-checksum-sha256"]).toBe("declared");
    expect(recorded.upload?.headers.authorization).toBeUndefined();
  });

  it("PUTs through the API, authenticated, when the storage cannot sign urls", async () => {
    const { client, fetchImpl, recorded } = harness({
      uploadViaServer: true,
      uploadUrl: "/api/v1/releases/x/upload",
      uploadHeaders: {},
    });
    await publishArchive({ ...params, client, fetchImpl, archive: await archiveOf([{ path: "a", data: Buffer.from("a") }]) });

    expect(recorded.upload?.method).toBe("PUT");
    expect(recorded.upload?.url).toBe("https://api.example/api/v1/releases/x/upload");
    expect(recorded.upload?.headers.authorization).toBe("Bearer ota_token");
    expect(recorded.upload?.headers["content-type"]).toBe("application/zip");
  });

  it("does not confirm a release whose upload failed", async () => {
    const { client, recorded } = harness();
    const failing = (async () => {
      recorded.order.push("upload");
      return new Response("nope", { status: 403, statusText: "Forbidden" });
    }) as unknown as typeof globalThis.fetch;

    await expect(
      publishArchive({
        ...params,
        client,
        fetchImpl: failing,
        archive: await archiveOf([{ path: "a", data: Buffer.from("a") }]),
      }),
    ).rejects.toThrow(/upload failed with 403/);
    expect(recorded.order).toEqual(["prepare", "upload"]);
  });
});
