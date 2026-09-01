---
title: Rollback
description: How a device reverts a release that crashed, and how the server pulls a release back from every device that has it.
---

Rollback happens in two directions, and they are separate mechanisms. The device protects itself from a build that will not boot. The server pulls a release back from everyone. Neither depends on the other.

## On the device: the crash watchdog

The boot path is where a release becomes live. Before React Native is handed a bundle path, the SDK promotes the pending release to current and writes `pendingVerification: true` to `state.json` — to disk, synchronously, first.

That ordering is the whole design. If the flag were written after the bundle loaded, a crash during the very first frame would leave no trace, and the next launch would look like a clean one and load the same broken bundle again, forever.

`notifyAppReady()` clears the flag. `<OtaProvider>` calls it automatically just after the first frame paints, which is late enough to prove React mounted and early enough that a slow screen does not read as a crash. Apps that would rather confirm after their own first data load pass `autoNotifyReady={false}` and call it themselves.

If the boot path finds the flag still armed from a previous launch, that launch died before the JavaScript could confirm itself. One strike is enough:

- the failed release id is appended to `failedReleaseIds` in `state.json`, capped at the most recent 10;
- `current` falls back to `previous`, or to nothing at all, which means the bundle inside the binary;
- a `rollback` event with `reason: "crash"` and the release it fell back to is appended to `events.jsonl`, so the report survives even if the app crashes again before it can send anything;
- `pending`, `pendingVerification` and any preview pin are cleared.

The same revert runs with `reason: "missing"` if the slot that should hold the current bundle no longer resolves to a JavaScript file.

### The failed list

Those 10 ids ride along on **every** update-check as `failed=id,id,…`. The server excludes them from the candidate list, so a release that broke on this device is never offered to this device again — even at 100% rollout, even after a resume.

The list also protects the device from a crash loop of the server's making. `decideTarget` treats a release the device has reported as failed as not runnable, so a device that just crashed on `v42` is not simply told to stay on `v42`:

```ts
const current =
  query.current && !failed.has(query.current)
    ? rows.find((r) => r.id === query.current && isNewerRelease(r.id, query.floor ?? null))
    : undefined;
```

The native download path enforces the same rule locally: a manifest whose id is in `failedReleaseIds` is rejected before a byte is fetched. `OpenOta.clearFailed()` empties the list, which is a debugging tool, not part of normal operation.

## On the server: pause, disable, roll back

Three verbs, three different meanings.

| Command | Status | Semantics |
|---|---|---|
| `ota pause <release>` | `paused` | stop offering to new devices; installed devices keep it |
| `ota resume <release>` | `active` | offer the release again |
| `ota disable <release>` | `disabled` | pull the release — devices converge away from it |

**Pause** is a brake. Paused releases are still in the candidate set the update-check reads, so the sticky rule keeps every device that already installed the release on it; only new admissions stop. Use it when the numbers look wrong and you want to stop the bleeding while you read them.

**Disable** is a recall. A disabled release leaves the candidate set entirely, so nothing keeps a device on it. Everyone converges off it.

`ota disable` asks first, and says where the devices will land:

```
? Disable v42 (ios, production)? Devices on it will move to the previous release
  or the embedded bundle. (y/N)
```

`ota rollback` is the incident-time shortcut: it disables the newest active release on a channel — one per platform — and reports the target for each.

```bash
ota rollback -c production
```

```
✔ v42 (ios) disabled — devices converge to v41.
✔ v42 (android) disabled — devices converge to v41.
Rollback shows up in the metrics within minutes as devices check in.
```

Pass `--release <id>` to roll back something other than the newest, and `-y` to skip the confirmation in a script.

## How a device converges

Nothing is pushed. On its next update-check the device sends the release it is running, and the server answers with where it should be instead.

- **A previous release still qualifies.** The answer is an ordinary `action: "update"` pointing at the older release. The device downloads it, verifies the signature and the digest exactly as it would for a new one, and runs it. It does not reuse the previous slot — that slot is reserved for the crash path, and re-downloading keeps one code path instead of two.
- **Nothing qualifies.** The answer is `action: "rollBackToEmbedded"`, and the device reverts to the bundle shipped inside the binary. `sync()` returns `{ status: "rolledBack" }`.
- **The device was already on the embedded bundle.** Nothing happens.

This is the same code path as an update, run in the other direction. That is deliberate: update, remote rollback and recovery are one mechanism, which is why each of them is dull.

The delay is the check interval, not a queue. A device that opens the app converges immediately; one sitting in a pocket converges when it is next opened.

:::caution
The crash watchdog is covered by tests but has not been exercised by a real crash on a physical device. Nothing in this project has run on a phone yet — see [Known limitations](/reference/limitations/).
:::
