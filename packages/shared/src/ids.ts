/**
 * UUIDv7 — time-ordered ids. Release identity carries its own chronology, so
 * "is this bundle newer than the one baked into the binary?" is a string
 * comparison against the embedded floor id, with no extra column and no clock
 * on the device. Concept borrowed from hot-updater's bundle ids.
 *
 * Layout (RFC 9562): 48-bit big-endian unix ms | ver(7) | 12 rand | var(0b10) | 62 rand.
 */

import { bytesToHex } from "./encoding.js";

export function uuidv7(now: number = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));

  const ts = BigInt(now);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);

  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 0b10

  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Milliseconds encoded in a v7 id. Returns null for other UUID versions. */
export function uuidv7Timestamp(id: string): number | null {
  const hex = id.replace(/-/g, "");
  if (hex.length !== 32) return null;
  if (((parseInt(hex.slice(12, 13), 16) & 0xf) as number) !== 7) return null;
  return parseInt(hex.slice(0, 12), 16);
}

/**
 * Ordering by id == ordering by creation time, which is what the update-check
 * floor comparison relies on. Plain lexicographic compare on the canonical
 * lowercase hyphenated form.
 */
export function isNewerRelease(candidate: string, floor: string | null | undefined): boolean {
  if (!floor) return true;
  return candidate.toLowerCase() > floor.toLowerCase();
}

export function uuidv4(): string {
  return crypto.randomUUID();
}
