/**
 * Guards the cross-language contract. Kotlin and Swift assert against these
 * same fixtures, so if canonicalize() ever changes shape here, this fails
 * before a released app starts rejecting every signature it is handed.
 *
 * Regenerate deliberately: pnpm --filter @open-ota/shared exec tsx scripts/generate-vectors.ts
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalize, verifyCanonical, verifyPreviewToken, type Json } from "../src/index.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "vectors");

const canonicalVectors = JSON.parse(await readFile(join(DIR, "canonical.json"), "utf8")) as {
  cases: Array<{ name: string; value: Json; canonical: string }>;
};
const signingVector = JSON.parse(await readFile(join(DIR, "signing.json"), "utf8")) as {
  publicKeyPem: string;
  manifest: Json;
  canonical: string;
  signature: string;
  tamperedManifest: Json;
  previewToken: { d: string; s: string; payload: { projectId: string; exp: number } };
};

describe("canonical JSON vectors", () => {
  for (const testCase of canonicalVectors.cases) {
    it(`still serialises "${testCase.name}" identically`, () => {
      expect(canonicalize(testCase.value)).toBe(testCase.canonical);
    });
  }

  it("covers the escapes the native mirrors are most likely to get wrong", () => {
    const names = canonicalVectors.cases.map((c) => c.name);
    expect(names).toContain("lone surrogate");
    expect(names).toContain("control characters");
    expect(names).toContain("unicode and emoji");
  });
});

describe("signing vectors", () => {
  it("verifies the fixture manifest against the fixture key", async () => {
    expect(await verifyCanonical(signingVector.manifest, signingVector.signature, signingVector.publicKeyPem)).toBe(
      true,
    );
  });

  it("rejects the tampered copy shipped alongside it", async () => {
    expect(
      await verifyCanonical(signingVector.tamperedManifest, signingVector.signature, signingVector.publicKeyPem),
    ).toBe(false);
  });

  it("keeps the canonical form of the manifest in step", () => {
    expect(canonicalize(signingVector.manifest)).toBe(signingVector.canonical);
  });

  it("accepts the fixture preview token before it expires", async () => {
    const result = await verifyPreviewToken(
      signingVector.previewToken.d,
      signingVector.previewToken.s,
      signingVector.publicKeyPem,
      {
        expectedProjectId: signingVector.previewToken.payload.projectId,
        now: (signingVector.previewToken.payload.exp - 60) * 1000,
      },
    );
    expect(result.ok).toBe(true);
  });
});
