/**
 * Canonical JSON — the exact bytes that get signed.
 *
 * Rules: object keys sorted by UTF-16 code unit, no insignificant whitespace,
 * no undefined values. Arrays keep their order. The native SDKs (Kotlin/Swift)
 * reimplement this; any change here is a wire-format break.
 */

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export function canonicalize(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;

  const keys = Object.keys(value).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const v = value[key];
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalize(v)}`);
  }
  return `{${parts.join(",")}}`;
}

export function canonicalBytes(value: Json): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(canonicalize(value));
}
