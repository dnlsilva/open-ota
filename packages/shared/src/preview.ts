/**
 * Preview deep links — "Open on device" from the dashboard.
 *
 * Knowing a release id must not be enough to install it, so the link carries a
 * payload signed with the project's own key, which the SDK already trusts:
 *
 *   myapp://ota/preview?d=<base64url(payload)>&s=<base64url(signature)>
 *
 * `purpose` gives domain separation — a preview token can never be replayed as
 * a manifest. See docs/API.md §4.3.
 */

import { signCanonical, verifyCanonical } from "./crypto.js";
import { base64UrlToBytes, bytesToBase64Url } from "./encoding.js";
import {
  PREVIEW_CLOCK_SKEW_SECONDS,
  PREVIEW_DEFAULT_TTL_MINUTES,
  PREVIEW_PURPOSE,
  previewTokenPayloadSchema,
  type PreviewTokenPayload,
} from "./protocol.js";

export interface PreviewLink {
  payload: PreviewTokenPayload;
  /** base64url of the canonical payload. */
  d: string;
  /** base64url of the detached RSA signature. */
  s: string;
}

export async function createPreviewToken(
  input: { projectId: string; releaseId: string; ttlMinutes?: number },
  privateKeyPem: string,
  now: number = Date.now(),
): Promise<PreviewLink> {
  const ttl = input.ttlMinutes ?? PREVIEW_DEFAULT_TTL_MINUTES;
  const payload: PreviewTokenPayload = {
    purpose: PREVIEW_PURPOSE,
    projectId: input.projectId,
    releaseId: input.releaseId,
    exp: Math.floor(now / 1000) + ttl * 60,
  };
  const signatureBase64 = await signCanonical(payload, privateKeyPem);
  return {
    payload,
    d: bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload))),
    s: bytesToBase64Url(base64ToBytesLocal(signatureBase64)),
  };
}

export function previewDeepLink(scheme: string, link: PreviewLink): string {
  return `${scheme}://ota/preview?d=${link.d}&s=${link.s}`;
}

export type PreviewVerifyFailure =
  | "malformed"
  | "badSignature"
  | "wrongProject"
  | "expired"
  | "wrongPurpose";

export type PreviewVerifyResult =
  | { ok: true; payload: PreviewTokenPayload }
  | { ok: false; reason: PreviewVerifyFailure };

export async function verifyPreviewToken(
  d: string,
  s: string,
  publicKeyPem: string,
  opts: { expectedProjectId: string; now?: number; clockSkewSeconds?: number },
): Promise<PreviewVerifyResult> {
  let payload: PreviewTokenPayload;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(d)));
    payload = previewTokenPayloadSchema.parse(parsed);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (payload.purpose !== PREVIEW_PURPOSE) return { ok: false, reason: "wrongPurpose" };

  const signatureBase64 = bytesToBase64Local(base64UrlToBytes(s));
  if (!(await verifyCanonical(payload, signatureBase64, publicKeyPem))) {
    return { ok: false, reason: "badSignature" };
  }

  if (payload.projectId !== opts.expectedProjectId) return { ok: false, reason: "wrongProject" };

  const skew = opts.clockSkewSeconds ?? PREVIEW_CLOCK_SKEW_SECONDS;
  const nowSeconds = Math.floor((opts.now ?? Date.now()) / 1000);
  if (payload.exp + skew < nowSeconds) return { ok: false, reason: "expired" };

  return { ok: true, payload };
}

// Local aliases so this module does not re-export the base64 helpers.
function base64ToBytesLocal(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToBase64Local(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
