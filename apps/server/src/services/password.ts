/**
 * Password hashing on Web Crypto (PBKDF2-HMAC-SHA256).
 *
 * Argon2id would be the stronger choice, but it needs a native module, and
 * this same code has to run inside a Supabase Edge Function and a Cloudflare
 * Worker. PBKDF2 at 600k iterations is the OWASP floor for SHA-256 and needs
 * nothing beyond the platform. The stored format carries the parameters, so
 * raising the cost — or moving to Argon2 on Node — stays a migration, not a
 * rewrite.
 *
 * Format: pbkdf2$sha256$<iterations>$<saltB64>$<hashB64>
 */

import { base64ToBytes, bytesToBase64, timingSafeEqual } from "@open-ota/shared";

const ITERATIONS = 600_000;
const KEY_LENGTH_BITS = 256;
const SALT_BYTES = 16;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, ITERATIONS);
  return `pbkdf2$sha256$${ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") return false;
  const iterations = Number(parts[2]);
  if (!Number.isFinite(iterations) || iterations < 1) return false;

  const salt = base64ToBytes(parts[3]!);
  const expected = parts[4]!;
  const actual = bytesToBase64(await derive(password, salt, iterations));
  return timingSafeEqual(actual, expected);
}

/** True when a stored hash used weaker parameters and should be upgraded on login. */
export function needsRehash(stored: string): boolean {
  const iterations = Number(stored.split("$")[2]);
  return !Number.isFinite(iterations) || iterations < ITERATIONS;
}

async function derive(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    KEY_LENGTH_BITS,
  );
  return new Uint8Array(bits);
}
