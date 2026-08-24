/**
 * Signing and hashing on Web Crypto only — the same code runs on Node 20+,
 * Deno (Supabase Edge Functions) and Cloudflare Workers.
 *
 * Algorithm: RSASSA-PKCS1-v1_5 + SHA-256, 2048-bit, detached signature over
 * canonical JSON. Chosen because iOS (SecKey) and Android (java.security)
 * verify it with platform APIs on every supported OS version, with no extra
 * native dependency. See docs/API.md §4.
 */

import { canonicalBytes, type Json } from "./canonical.js";
import { base64ToBytes, bytesToBase64, bytesToHex } from "./encoding.js";

const RSA_PARAMS = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

export const SIGNATURE_ALG = "RS256" as const;

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error("Web Crypto unavailable — Node 20+, Deno or Workers required");
  return c.subtle;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await subtle().digest("SHA-256", data as BufferSource);
  return bytesToHex(new Uint8Array(digest));
}

/** Streaming-friendly hash for large files, used by the CLI before upload. */
export async function sha256HexOfChunks(chunks: AsyncIterable<Uint8Array>): Promise<string> {
  // Web Crypto has no incremental digest; collect then hash. Bundles are
  // bounded by MAX_BUNDLE_BYTES, so peak memory stays predictable.
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of chunks) {
    parts.push(chunk);
    total += chunk.length;
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return sha256Hex(joined);
}

export interface KeyPairPem {
  publicKeyPem: string;
  privateKeyPem: string;
}

export async function generateSigningKeyPair(): Promise<KeyPairPem> {
  const pair = await subtle().generateKey(
    { ...RSA_PARAMS, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  );
  const spki = new Uint8Array(await subtle().exportKey("spki", pair.publicKey));
  const pkcs8 = new Uint8Array(await subtle().exportKey("pkcs8", pair.privateKey));
  return {
    publicKeyPem: toPem(spki, "PUBLIC KEY"),
    privateKeyPem: toPem(pkcs8, "PRIVATE KEY"),
  };
}

export async function signCanonical(payload: Json, privateKeyPem: string): Promise<string> {
  const key = await importPrivateKey(privateKeyPem);
  const sig = await subtle().sign(RSA_PARAMS.name, key, canonicalBytes(payload) as BufferSource);
  return bytesToBase64(new Uint8Array(sig));
}

export async function verifyCanonical(
  payload: Json,
  signatureBase64: string,
  publicKeyPem: string,
): Promise<boolean> {
  try {
    const key = await importPublicKey(publicKeyPem);
    return await subtle().verify(
      RSA_PARAMS.name,
      key,
      base64ToBytes(signatureBase64) as BufferSource,
      canonicalBytes(payload) as BufferSource,
    );
  } catch {
    return false;
  }
}

export async function importPrivateKey(pem: string): Promise<CryptoKey> {
  return subtle().importKey("pkcs8", fromPem(pem) as BufferSource, RSA_PARAMS, false, ["sign"]);
}

export async function importPublicKey(pem: string): Promise<CryptoKey> {
  return subtle().importKey("spki", fromPem(pem) as BufferSource, RSA_PARAMS, false, ["verify"]);
}

function toPem(der: Uint8Array, label: string): string {
  const body = bytesToBase64(der).replace(/(.{64})/g, "$1\n").trimEnd();
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

function fromPem(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  return base64ToBytes(body);
}

/**
 * Project private keys are encrypted at rest with AES-256-GCM under
 * OTA_MASTER_KEY. Format: base64(iv[12] || ciphertext || tag).
 */
export async function encryptSecret(plaintext: string, masterKeyBase64: string): Promise<string> {
  const key = await importMasterKey(masterKeyBase64, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await subtle().encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(plaintext) as BufferSource,
    ),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return bytesToBase64(out);
}

export async function decryptSecret(payload: string, masterKeyBase64: string): Promise<string> {
  const key = await importMasterKey(masterKeyBase64, ["decrypt"]);
  const raw = base64ToBytes(payload);
  const iv = raw.subarray(0, 12);
  const ct = raw.subarray(12);
  const pt = await subtle().decrypt({ name: "AES-GCM", iv }, key, ct as BufferSource);
  return new TextDecoder().decode(pt);
}

async function importMasterKey(masterKeyBase64: string, usages: KeyUsage[]): Promise<CryptoKey> {
  const raw = base64ToBytes(masterKeyBase64);
  if (raw.length !== 32) throw new Error("OTA_MASTER_KEY must be 32 bytes, base64 encoded");
  return subtle().importKey("raw", raw as BufferSource, "AES-GCM", false, usages);
}

export function generateMasterKey(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
}

/** Opaque API tokens: `ota_<random>`, stored only as a SHA-256 hex hash. */
export function generateApiToken(prefix = "ota"): string {
  const raw = crypto.getRandomValues(new Uint8Array(24));
  return `${prefix}_${bytesToHex(raw)}`;
}

export async function hashToken(token: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(token));
}
