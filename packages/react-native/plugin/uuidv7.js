"use strict";
/**
 * The embedded floor id: a UUIDv7 minted per build, so the server never offers
 * a release older than the bundle baked into the binary (ARCHITECTURE §5).
 *
 * Prefers @open-ota/shared, but falls back to a local copy: config plugins are
 * CommonJS and shared currently ships ESM TypeScript sources, which `require`
 * cannot load. Same RFC 9562 layout as packages/shared/src/ids.ts.
 */

const { randomBytes } = require("node:crypto");

function local(now = Date.now()) {
  const bytes = randomBytes(16);
  const ts = BigInt(now);
  for (let i = 0; i < 6; i++) bytes[i] = Number((ts >> BigInt(40 - i * 8)) & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uuidv7(now) {
  try {
    return require("@open-ota/shared").uuidv7(now);
  } catch {
    return local(now);
  }
}

module.exports = { uuidv7 };
