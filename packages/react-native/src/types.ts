/**
 * Public types of the JS SDK. The wire shapes live in @open-ota/shared — only
 * what an app actually touches is restated here.
 */

import type { RollbackReason } from "@open-ota/shared";

export interface ReleaseRef {
  id: string;
  label: number;
}

export interface OtaStatus {
  /** Anonymous UUID minted on first launch, persisted by the native module. */
  deviceId: string;
  channel: string;
  runtimeVersion: string;
  nativeVersion: string;
  /** null means the app is running the bundle baked into the binary. */
  currentRelease: ReleaseRef | null;
  /** Downloaded and staged, applies on the next launch. */
  pendingRelease: ReleaseRef | null;
  /** Releases that failed on this device; sent on every update-check. */
  failedReleases: string[];
  /** Pinned by a preview deep link — update-check stays suspended. */
  isPreview: boolean;
}

export type SyncResult =
  | { status: "upToDate" }
  | { status: "updated"; release: ReleaseRef; mandatory: boolean; reloaded: boolean }
  | { status: "rolledBack" }
  | { status: "pinned" }
  | { status: "incompatible"; runtimeVersion: string }
  | { status: "error"; error: Error };

export interface DownloadProgress {
  releaseId: string;
  bytesWritten: number;
  /** 0 while the CDN sends no content-length. */
  totalBytes: number;
  /** 0..1, clamped; 0 when totalBytes is unknown. */
  fraction: number;
}

export type UpdateState =
  | { state: "downloading"; releaseId: string }
  | { state: "downloaded"; releaseId: string }
  | { state: "installed"; releaseId: string }
  | { state: "ready"; releaseId: string }
  | { state: "rollback"; releaseId: string; reason: RollbackReason; fromReleaseId?: string }
  | { state: "verifyFailed"; releaseId: string; stage: string }
  | { state: "error"; message: string; releaseId?: string };

/** Emitted when the OS opens `<scheme>://ota/preview?d=&s=`. */
export interface PreviewRequest {
  url?: string;
  d?: string;
  s?: string;
}

export interface OtaEventMap {
  downloadProgress: DownloadProgress;
  updateState: UpdateState;
  previewRequested: PreviewRequest;
}

export interface Subscription {
  remove(): void;
}
