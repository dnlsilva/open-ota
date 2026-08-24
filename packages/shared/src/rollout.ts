/**
 * Gradual rollout — stateless, deterministic bucketing.
 *
 * bucket = sha256(deviceId + ":" + releaseId)[0..8) % 10000, offered when
 * bucket < rolloutPercent * 100. Salting with the release id keeps a device
 * from landing in the first 10% of every release. No release×device table:
 * the same device always resolves to the same bucket, so raising the
 * percentage only ever adds devices.
 */

import { sha256Hex } from "./crypto.js";
import { utf8 } from "./encoding.js";

export const BUCKET_SPACE = 10_000;

export async function rolloutBucket(deviceId: string, releaseId: string): Promise<number> {
  const hex = await sha256Hex(utf8(`${deviceId}:${releaseId}`));
  return parseInt(hex.slice(0, 8), 16) % BUCKET_SPACE;
}

export async function isInRollout(
  deviceId: string,
  releaseId: string,
  rolloutPercent: number,
): Promise<boolean> {
  if (rolloutPercent >= 100) return true;
  if (rolloutPercent <= 0) return false;
  const bucket = await rolloutBucket(deviceId, releaseId);
  return bucket < Math.round(rolloutPercent * (BUCKET_SPACE / 100));
}

/**
 * Share of devices a percentage is expected to reach — used by the dashboard
 * to preview a rollout change before it is applied.
 */
export function estimatedReach(totalDevices: number, rolloutPercent: number): number {
  return Math.round(totalDevices * (Math.min(100, Math.max(0, rolloutPercent)) / 100));
}
