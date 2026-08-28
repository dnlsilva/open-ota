/**
 * The only module that touches the native side. Everything else talks to this
 * typed surface, so the package can be imported in Node (tests, Metro config,
 * lint) without a native module present: the fallback only throws when a
 * method is actually called.
 *
 * Constants are stamped into the binary at build time by the config plugin
 * (Expo) or the codemods (bare RN) — see plugin/codemods/edits.js.
 */

import type { Platform, RollbackReason } from "@open-ota/shared";
import type { OtaEventMap, OtaStatus, Subscription } from "./types.js";

export interface OtaConstants {
  apiUrl: string;
  appKey: string;
  projectId: string;
  channel: string;
  /** Fingerprint of the native project; updates must match it exactly. */
  runtimeVersion: string;
  /** Base64 SPKI (DER). PEM armor is stripped at build time. */
  publicKey: string;
  /** UUIDv7 minted per build; the server never offers a release below it. */
  embeddedFloorId: string | null;
  nativeVersion: string;
  deepLinkScheme: string | null;
}

export interface OpenOtaNativeModule extends OtaConstants {
  getStatus(): Promise<OtaStatus>;
  downloadUpdate(manifestJson: string, signatureBase64: string, url: string): Promise<void>;
  applyUpdate(reload: boolean): Promise<void>;
  notifyAppReady(): Promise<void>;
  reload(): Promise<void>;
  rollback(reason: RollbackReason): Promise<void>;
  setChannel(channel: string): Promise<void>;
  exitPreview(): Promise<void>;
  clearFailed(): Promise<void>;
  addListener<E extends keyof OtaEventMap>(
    event: E,
    listener: (payload: OtaEventMap[E]) => void,
  ): Subscription;
}

const MISSING =
  "Open OTA: native module not found. Rebuild the app (expo prebuild && expo run:ios/android, " +
  "or `ota init` for bare React Native) — this SDK cannot run over a JS-only reload.";

function unavailable(): never {
  throw new Error(MISSING);
}

function stub(): OpenOtaNativeModule {
  return {
    apiUrl: "",
    appKey: "",
    projectId: "",
    channel: "",
    runtimeVersion: "",
    publicKey: "",
    embeddedFloorId: null,
    nativeVersion: "",
    deepLinkScheme: null,
    getStatus: unavailable,
    downloadUpdate: unavailable,
    applyUpdate: unavailable,
    notifyAppReady: unavailable,
    reload: unavailable,
    rollback: unavailable,
    setChannel: unavailable,
    exitPreview: unavailable,
    clearFailed: unavailable,
    addListener: unavailable,
  };
}

let cached: OpenOtaNativeModule | undefined;
let injected: OpenOtaNativeModule | undefined;

/** Test seam: swap the native module out. Pass undefined to restore. */
export function setNativeModule(mock: OpenOtaNativeModule | undefined): void {
  injected = mock;
  cached = undefined;
}

export function nativeModule(): OpenOtaNativeModule {
  if (injected) return injected;
  if (cached) return cached;
  try {
    // Deliberately lazy: a top-level import of expo-modules-core breaks any
    // Node process that merely imports this package.
    const core = require("expo-modules-core") as {
      requireNativeModule: (name: string) => OpenOtaNativeModule;
    };
    cached = core.requireNativeModule("OpenOta");
  } catch {
    cached = stub();
  }
  return cached;
}

export function isNativeModuleAvailable(): boolean {
  return nativeModule().appKey !== "";
}

/** react-native is a peer dep; absent only in Node, where callers pass platform explicitly. */
export function currentPlatform(): Platform {
  try {
    const rn = require("react-native") as { Platform: { OS: string } };
    return rn.Platform.OS === "ios" ? "ios" : "android";
  } catch {
    return "android";
  }
}
