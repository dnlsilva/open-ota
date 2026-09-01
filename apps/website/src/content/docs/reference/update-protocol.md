---
title: Update protocol
description: The wire protocol between the SDK and the Device API — update-check, events and preview.
---

Three routes, all under `/api/v1`, all authenticated by the project's public app
key in `x-ota-app-key`. The key identifies but never authorises: what protects
the payload is the signature over the manifest, not a secret held on the device.
The shapes below come from `packages/shared/src/protocol.ts`, which the Kotlin
and Swift SDKs mirror.

## GET /update-check

```
x-ota-app-key: pk_a1b2...
?platform=android
&channel=production
&runtime=fp_9f8e7d...        # fingerprint of the binary
&device=3f7a...              # anonymous id, generated on the device
&current=0193a4c8-...        # release running now; absent = the embedded bundle
&floor=01939f...             # release id stamped into the binary at build time
&native=1.4.2                # versionName / CFBundleShortVersionString
&failed=0193a1...,0193a2...  # releases that failed on this device
```

`platform` is `ios` or `android`. `channel` is 1–64 characters, `runtime`
1–128, `device` 8–64, `native` up to 64. `current` and `floor` are uuids.
`failed` is a comma-separated list, **capped at 10 entries** — the rest are
dropped, so the query string stays bounded.

### Target release

The server answers one question: which release should this device be running.
Candidates are the releases matching this project, channel, platform and an
**exact** `runtime` match, with status `active` or `paused`, newest id first.
An unknown channel is not an error for a device in the field — it simply has
nothing to install, and gets `none`.

From that list, walking newest to oldest:

1. Skip anything in `failed`.
2. Skip anything not newer than `floor`. A device never receives a bundle older
   than the JavaScript baked into its binary.
3. If the id equals `current`, take it and stop. Sticky: a device already on a
   release keeps it even after the rollout is paused. Only `disabled` pulls a
   device off something it already runs.
4. Otherwise the release must be `active` and the device must fall inside its
   rollout bucket.

The first match wins. Then:

- `target == current` → `{"action":"none"}`
- a target exists and differs → `{"action":"update", ...}`
- no target, and `current` no longer qualifies → `{"action":"rollBackToEmbedded"}`
- no target, and `current` is still runnable → `none`

`update` covers a downgrade as well as an upgrade. If the release a device runs
was disabled, the target is the previous one and the device converges *down* to
it through the same code path. "Still runnable" is stricter than "still
exists": a device that reported its own release as failed is not told to stay
on it, or it would sit in a crash loop while the server answered `none`.

Rollout membership is stateless and deterministic:

```
bucket = int(sha256(deviceId + ":" + releaseId)[0..8), 16) % 10000
offered when bucket < round(rolloutPercent * 100)
```

Salting with the release id keeps a device out of the first 10% of every
release. Because the bucket never moves, raising a percentage only ever adds
devices.

The response is always sent with `cache-control: no-store` — bundles are
immutable, but the decision is per device.

### The response

```json
{
  "action": "update",
  "mandatory": false,
  "manifest": {
    "id": "0193a4c8-9d2e-7c31-b7a1-6f0e2d4a91c3",
    "projectId": "0193a0f1-2b44-7a10-9c33-1de4f0a72b58",
    "platform": "android",
    "channel": "production",
    "runtimeVersion": "fp_9f8e7d6c5b4a",
    "label": 42,
    "sha256": "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    "size": 4812345,
    "createdAt": "2026-09-01T12:00:00.000Z"
  },
  "signature": "base64 RSA-SHA256 over the canonical manifest",
  "url": "https://cdn.example.com/bundles/0193a0f1-.../0193a4c8-....zip"
}
```

The other two are exactly:

```json
{ "action": "none" }
{ "action": "rollBackToEmbedded" }
```

**`url` sits outside the signed manifest on purpose.** It is transport. Move
CDNs, change domains, put a cache in front, and every existing release stays
valid, because integrity comes from `sha256` and authenticity from the detached
signature. An attacker who swaps the URL can only deliver bytes that fail the
hash. See the [security model](/reference/security/).

Side effect: this request is the telemetry heartbeat. The device row is upserted
here, at most once an hour unless something changed.

## POST /events

```json
{
  "device": "3f7a1c92-4d5e-4f11-9b3c-8a2f7e6d0c11",
  "platform": "android",
  "channel": "production",
  "native": "1.4.2",
  "runtime": "fp_9f8e7d6c5b4a",
  "events": [
    { "type": "download", "release": "0193a4c8-...", "ts": 1756731600 },
    { "type": "install",  "release": "0193a4c8-...", "ts": 1756731610 },
    { "type": "ready",    "release": "0193a4c8-...", "ts": 1756731620 },
    { "type": "rollback", "release": "0193a4c8-...", "ts": 1756731699,
      "meta": { "reason": "crash", "from": "0193a3b7-..." } },
    { "type": "verifyFailed", "release": "0193a4c8-...", "ts": 0,
      "meta": { "stage": "sha256" } }
  ]
}
```

`events` holds 1 to 50 entries. `type` is one of `download`, `install`,
`ready`, `rollback`, `verifyFailed`. `reason` is `crash`, `verifyFailed`,
`server` or `manual`. `stage` is up to 64 characters and `message` up to 512.
Only `device` and `events` are required.

The response is **202** with an empty body. The SDK queues events on disk and
retries, so the server folds each batch into daily counters and drops any
release id that does not belong to this project — an app key is public, so
those ids are untrusted input. A rollback also increments the failed counter,
which is what makes the funnel add up.

## GET /preview/manifest

```
GET /api/v1/preview/manifest?d=<base64url payload>&s=<base64url signature>
x-ota-app-key: pk_a1b2...
```

The device already verified the token locally; the server verifies it again,
with **zero** clock skew tolerance, so a short expiry doubles as revocation. The
release must belong to the token's project and must have a confirmed bundle.

The response is the same shape as an `update`, with `mandatory` set to `false`
and `cache-control: no-store`. The SDK applies it pinned until `exitPreview()`.
