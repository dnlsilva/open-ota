/**
 * Preview deep links — "Open on device" from the dashboard.
 *
 * The token is verified twice on purpose: here, against the public key baked
 * into the binary (so a bogus link never reaches the network), and again by the
 * server, whose short expiry is what makes a link revocable. See API.md §4.3.
 */

import {
  APP_KEY_HEADER,
  SDK_VERSION_HEADER,
  updateCheckResponseSchema,
  verifyPreviewToken,
  type PreviewVerifyFailure,
} from "@open-ota/shared";
import { nativeModule } from "./native.js";
import type { PreviewRequest, ReleaseRef, Subscription } from "./types.js";
import { SDK_VERSION } from "./version.js";

export type PreviewFailure =
  | PreviewVerifyFailure
  | "noToken"
  | "manifestUnavailable"
  | "incompatibleRuntime"
  | "installFailed";

export type PreviewResult =
  | { ok: true; release: ReleaseRef }
  | { ok: false; reason: PreviewFailure; message: string };

/** Accepts either the raw deep link or the already-split query params. */
export function parsePreviewLink(request: PreviewRequest): { d: string; s: string } | null {
  const d = request.d ?? param(request.url, "d");
  const s = request.s ?? param(request.url, "s");
  return d && s ? { d, s } : null;
}

function param(url: string | undefined, name: string): string | undefined {
  if (!url) return undefined;
  const match = new RegExp(`[?&]${name}=([^&#]*)`).exec(url);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

export interface PreviewDeps {
  apiUrl: string;
  appKey: string;
  projectId: string;
  /** Base64 SPKI; shared's PEM reader accepts it unarmored. */
  publicKey: string;
  runtimeVersion: string;
  fetchImpl?: typeof globalThis.fetch;
  install: (manifestJson: string, signature: string, url: string) => Promise<void>;
}

export async function handlePreviewRequest(
  request: PreviewRequest,
  deps: PreviewDeps,
): Promise<PreviewResult> {
  const token = parsePreviewLink(request);
  if (!token) return fail("noToken", "Preview link is missing its d/s parameters.");

  const verified = await verifyPreviewToken(token.d, token.s, deps.publicKey, {
    expectedProjectId: deps.projectId,
  });
  if (!verified.ok) return fail(verified.reason, PREVIEW_MESSAGES[verified.reason]);

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const url =
    `${deps.apiUrl.replace(/\/+$/, "")}/api/v1/preview/manifest` +
    `?d=${encodeURIComponent(token.d)}&s=${encodeURIComponent(token.s)}`;

  let raw: unknown;
  try {
    const res = await fetchImpl(url, {
      headers: {
        accept: "application/json",
        [APP_KEY_HEADER]: deps.appKey,
        [SDK_VERSION_HEADER]: SDK_VERSION,
      },
    });
    if (!res.ok) {
      return fail("manifestUnavailable", `Server refused the preview link (${res.status}).`);
    }
    raw = await res.json();
  } catch (error) {
    return fail("manifestUnavailable", `Could not reach ${deps.apiUrl}: ${String(error)}`);
  }

  // The endpoint returns the update-check payload minus the action wrapper.
  const body = raw as Record<string, unknown>;
  const parsed = updateCheckResponseSchema.safeParse({
    action: "update",
    mandatory: true,
    ...body,
  });
  if (!parsed.success || parsed.data.action !== "update") {
    return fail("manifestUnavailable", "Preview response did not contain a signed manifest.");
  }

  const { manifest, signature, url: bundleUrl } = parsed.data;
  if (manifest.runtimeVersion !== deps.runtimeVersion) {
    return fail(
      "incompatibleRuntime",
      `This release needs a build with runtime ${manifest.runtimeVersion}; ` +
        `this device runs ${deps.runtimeVersion}. Install a matching build first.`,
    );
  }

  try {
    await deps.install(JSON.stringify(body.manifest ?? manifest), signature, bundleUrl);
  } catch (error) {
    return fail("installFailed", `Preview install failed: ${String(error)}`);
  }

  return { ok: true, release: { id: manifest.id, label: manifest.label } };
}

const PREVIEW_MESSAGES: Record<PreviewVerifyFailure, string> = {
  malformed: "Preview link is malformed.",
  badSignature: "Preview link was not signed by this project's server.",
  wrongProject: "Preview link belongs to another project.",
  wrongPurpose: "Token is not a preview token.",
  expired: "Preview link has expired — generate a new one.",
};

function fail(reason: PreviewFailure, message: string): PreviewResult {
  return { ok: false, reason, message };
}

let subscription: Subscription | undefined;

/**
 * Wires the native "previewRequested" event. Idempotent — OtaProvider calls it
 * on mount, and an app without the provider can call it itself.
 */
export function installPreviewHandler(
  onResult?: (result: PreviewResult) => void,
): Subscription {
  if (subscription) return subscription;
  const native = nativeModule();
  subscription = native.addListener("previewRequested", (request) => {
    void handlePreviewRequest(request, {
      apiUrl: native.apiUrl,
      appKey: native.appKey,
      projectId: native.projectId,
      publicKey: native.publicKey,
      runtimeVersion: native.runtimeVersion,
      install: async (manifestJson, signature, url) => {
        await native.downloadUpdate(manifestJson, signature, url);
        // Preview always reloads: someone is standing there with a QR code.
        await native.applyUpdate(true);
      },
    }).then((result) => {
      if (!result.ok) console.warn(`[open-ota] preview rejected: ${result.message}`);
      onResult?.(result);
    });
  });
  return {
    remove: () => {
      subscription?.remove();
      subscription = undefined;
    },
  };
}
