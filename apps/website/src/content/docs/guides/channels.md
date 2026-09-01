---
title: Channels and promotion
description: How channels separate audiences, what promote actually copies, and how a QA build switches channel at runtime.
---

A channel is a named stream of releases inside a project. A device asks for one channel and only ever sees releases published to it.

`development`, `staging` and `production` are conventions, not fixtures. A channel row is created the first time something references it, so `ota publish -c canary` works without any setup, and so does `ota promote v7 hotfix`.

```bash
ota publish -c staging --rollout 100
ota releases -c staging
```

The channel a device asks for comes from the binary — `channel` in the config plugin options, defaulting to `production` — unless the app overrode it at runtime.

An update-check for a channel that does not exist returns `action: "none"`. A device in the field with a typo in its config has nothing to install, which is a better outcome than an error it cannot act on.

## Labels are per channel

Labels are the next integer within one project, channel and platform. `v42` on `staging` and `v42` on `production` are unrelated releases that happen to share a number. That is why the CLI asks which channel to resolve a label against, and why it refuses an ambiguous one:

```
✘ v12 exists for ios and android on staging.
  Pass --platform, or use the release id.
```

Release ids are UUIDv7 and unambiguous everywhere a label is accepted.

## What promote actually does

```bash
ota promote v12 production --rollout 10
```

```
✔ Promoted v12 (ios) to production as v43 at 10%.
```

Promotion **copies** the release into the destination channel. The server inserts a new row with:

- a new release id and a new label, numbered in the destination channel;
- the **same** `storageKey`, `sha256`, `size`, `runtimeVersion` and `groupId` as the source;
- a freshly signed manifest, because `id`, `label`, `channel` and `createdAt` are part of the signed payload;
- status `active`, and a rollout of 100% unless `--rollout` says otherwise.

Nothing is re-exported, re-hashed or re-uploaded. The bytes in the bucket are the identical object, and a device that already downloaded them under the staging release will download them again under the production release — the digest is the same, the release identity is not.

Promoting into the channel a release already lives in is a conflict error, not a no-op.

### Why a copy instead of a pointer

The obvious alternative is a per-channel pointer that moves. It makes promotion cheap and history a lie: `production` would have no record of what it served last Tuesday, only of what it serves now, and rolling back would mean moving the pointer somewhere it had already been.

Copying keeps each channel's history append-only. Every row is a thing that was offered, at a rollout, for a window of time, with its own metrics. Nothing that was true stops being true.

## Runtime channel switching

A build can move itself to another channel without a rebuild:

```tsx
import { OpenOta } from "@open-ota/react-native";

await OpenOta.setChannel("staging");
await OpenOta.sync();
```

`setChannel` persists a `channelOverride` in the SDK's `state.json`, which takes precedence over the channel baked into the binary from that point on. `getStatus().channel` reflects the override. Passing `null` or an empty string clears it and falls back to the build's channel.

This is what QA builds are for: one binary, a hidden switch, and the tester can pull `staging` without a separate app id. It does not bypass anything else — the release still has to match the binary's fingerprint, and the rollout bucket is still computed the same way.

It does not trigger a check. Call `sync()` afterwards, or wait for the next launch.

:::caution
The next check after a switch is answered entirely from the new channel. The server looks for the best release on `staging` for this platform and runtime; if it finds one the device updates to it, and if the channel has nothing to offer, a device that was running a `production` release is told to fall back to the bundle inside the binary. Switching is not a read-only operation — it can move a device down as well as sideways.
:::
