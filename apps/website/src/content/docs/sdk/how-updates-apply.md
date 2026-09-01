---
title: How updates apply
description: The native mechanics — the boot decision, the two slots, the download pipeline, and why promotion waits for a launch.
---

Everything a release does on a device happens in three places: a synchronous decision at boot, a verification pipeline during download, and a promotion that only ever runs at boot.

## The boot decision

`OpenOta.getBundleFile(context)` on Android and `OpenOta.bundleURL()` on iOS answer one question — which JavaScript file should React Native load — and they answer it **synchronously, from local state, with no network**. The app is not waiting on a server to start.

In order, one call:

1. If `pendingVerification` is still armed from a previous launch, that launch died before confirming itself. Revert. Once per process.
2. Drop anything below the embedded floor id, so a bundle staged before an app upgrade is never promoted into a newer binary.
3. Promote the pending release to current, and arm `pendingVerification`.
4. **Write `state.json` to disk.** Before returning a path.
5. Resolve the bundle inside the current slot. If it cannot be found, revert with `reason: "missing"` and resolve again.

Any throwable in that whole path is caught and turns into `null`, which means the bundle inside the binary. The update layer is never allowed to stop the app from booting.

## Slots and state

```
<app-data>/open-ota/
  slots/A          extracted bundle, in the expo export layout
  slots/B
  state.json       which slot is which
  events.jsonl     events produced natively, drained by JS
  tmp/             in-flight downloads
```

Two slots alternate. A download always writes to the slot that is not backing the running bundle, so the running bundle is never touched and whatever was in the free slot is forfeit. `state.json` tracks `current`, `previous` and `pending` — each an id, a slot and a label — plus `pendingVerification`, `failedReleaseIds`, `previewReleaseId`, `deviceId` and `channelOverride`.

Every write goes to a temp file, is fsynced, and is renamed into place. A half-written `state.json` read at boot would be indistinguishable from "no update installed" and would strand the device on the embedded bundle.

Finding the bundle inside a slot tries three things in order: a plain `index.android.bundle` / `main.jsbundle` / `index.bundle` at the root; the path `metadata.json` names under `fileMetadata.<platform>.bundle`; then a search for the first `.hbc` or `.bundle`, skipping `assets/`, six directories deep.

## The download pipeline

`downloadUpdate(manifestJson, signature, url)` runs six steps, and every one of them can only fail closed:

1. **Signature.** RSA verification over the SDK's own canonical re-serialization of the manifest, against the public key baked into the binary. Not over the bytes as they arrived — canonicalizing locally is what makes the check independent of whitespace and key order on the wire.
2. **Identity.** The manifest's `projectId`, `platform` and `runtimeVersion` must match this binary. The release must not be in `failedReleaseIds`, and its id must sort above the embedded floor.
3. **Transfer.** The zip is streamed to `tmp/`, bounded by the declared size and a 200 MB ceiling, emitting `downloadProgress` as it goes.
4. **Digest.** SHA-256 of the downloaded file against `manifest.sha256`.
5. **Extract.** Into the free slot, refusing any entry whose path is absolute, contains `..`, or canonicalizes outside the slot directory. Then confirm a JavaScript bundle actually exists inside, or the archive was not what it claimed to be.
6. **Stage.** Record it as `pending` in `state.json`.

The bundle URL sits deliberately **outside** the signed manifest. It is transport: move CDNs, change domains, put a cache in front, and every existing release stays valid. Integrity comes from the digest and authenticity from the signature, so a compromised CDN can only serve bytes that fail the hash.

Any failure deletes the slot, emits a failed state, and rejects with a typed code — `ERR_OTA_SIGNATURE_INVALID`, `ERR_OTA_HASH_MISMATCH`, `ERR_OTA_MANIFEST_MISMATCH`, `ERR_OTA_EXTRACT_FAILED` and so on.

## Why promotion waits for a launch

A downloaded release is `pending`. It becomes `current` in the boot path and nowhere else.

The tempting alternative is to promote as soon as the download verifies. It breaks in a specific way: promotion arms the crash watchdog, and the watchdog is a claim about *the bundle now running*. Arm it while the old bundle is still executing and any crash from that point on — in code that has nothing to do with the new release — reverts the new release and adds it to the failed list. The device would blacklist a build it never actually ran.

Promoting at boot keeps the flag and the running bundle describing the same thing. `applyUpdate(false)` therefore does almost nothing: it confirms something is queued, and that is all there is to do.

## Mandatory reload

`applyUpdate(true)` reloads now instead of waiting.

On iOS this re-enters `bundleURL()` — which is where the promotion happens — then calls `RCTReloadCommandSetBundleURL` and triggers the reload listeners.

On Android neither `ReactInstanceManager` nor `ReactHost` re-reads the bundle path on reload, so the SDK swaps the `JSBundleLoader` by reflection, the same technique CodePush and hot-updater use. If the swap fails, the SDK **restores the state snapshot it took first** and rejects with `ERR_OTA_RELOAD_UNSUPPORTED`. The release then applies on the next launch, exactly as a non-mandatory one would.

That restore is the point. Reloading without swapping would run the old bundle while `state.json` claims the new one is live — and would arm a crash rollback against a release that never got a chance to run. Degrading to "next launch" is the honest failure.

:::caution
The reflection path needs checking per React Native version, and has not been run on a physical device. See [Known limitations](/reference/limitations/).
:::

## The embedded bundle is always there

The bundle compiled into the binary is never deleted, never modified, and never depends on anything the SDK wrote. It is what runs when there is no OTA release, when the current release was reverted, when the slot cannot be resolved, when the state file is unreadable, and when anything at all in the boot path throws.

The worst case for this system is that the app boots its shipped bundle. That is a property worth stating in one line, because it is the reason every other decision here can afford to fail closed.

:::note
Whether React Native resolves `require`d images from an updated bundle is still unmeasured on hardware. JavaScript-only changes should be fine; adding or changing an image may not be — see [Native compatibility](/guides/native-compatibility/) and [Known limitations](/reference/limitations/).
:::
