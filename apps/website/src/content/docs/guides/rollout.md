---
title: Gradual rollout
description: The bucketing formula behind a percentage, why it is deterministic and stateless, and what raising or lowering it actually does.
---

A release carries a rollout percentage between 0 and 100. The server decides per device whether that device is inside the slice.

```
bucket = sha256(deviceId + ":" + releaseId) % 10000
offered when bucket < round(rolloutPercent * 100)
```

The digest is taken over the UTF-8 string `deviceId:releaseId`; the bucket is the first 8 hex characters read as an integer, modulo 10,000. Ten thousand buckets is what makes 0.01% a meaningful number. `rolloutPercent >= 100` and `<= 0` short-circuit before any hashing.

## Deterministic and stateless

There is no `release × device` table. Nothing is written when a device is admitted to a rollout, nothing is read to decide, and the answer for a given pair never changes. That has three consequences worth stating plainly:

- **Cost does not grow with the rollout.** Admitting a million devices to a release costs the same as admitting ten, because admission is a hash, not a row.
- **The answer is stable across servers and restarts.** Any instance computes the same bucket, so a rollout behaves identically behind a load balancer or after a redeploy.
- **You can reason about it offline.** Given a device id and a release id, you can compute by hand whether that device is in.

## Salted per release

The release id is in the hash, not just the device id. Without it, a device with a low bucket would be in the first 1% of *every* release forever — your canary group would be the same few thousand people, and the same few thousand people would eat every bad build.

With it, membership is re-drawn per release. A device that received yesterday's canary is no more likely than any other to receive today's.

## Raising adds, lowering does not remove

The bucket is fixed and the threshold moves, so raising a percentage only ever widens the set. A device that was offered a release at 10% is still offered it at 25%. Nobody is pulled off a build they already have.

Lowering is not the reverse. It narrows the set of devices that *would be offered* the release, but a device already running it keeps it. The update-check makes that explicit — before it looks at status or rollout, it checks whether the candidate is the release the device is already on:

```ts
// Sticky: a device already on a release keeps it even once the rollout is
// paused. Only `disabled` pulls devices off a release they already run.
if (row.id === query.current) {
  target = row;
  break;
}
```

Set a release to 0% and the devices already on it stay on it. To actually take a release back you have to disable it — see [Rollback](/guides/rollback/).

Both interfaces say this out loud rather than letting a shrinking number imply a recall:

```bash
ota rollout v42 10
```

```
! Lowering 25% → 10% stops new devices only; devices already on v42 keep it.
✔ v42 (ios) is now at 10%.
```

The dashboard slider does the same. Moving it opens a confirmation that names the old and new values, with a warning tone when the number goes down.

## Mandatory releases

`--mandatory` at publish time changes *when* an update takes effect, not *who* gets it. The rollout percentage still decides who is offered it.

A normal release downloads in the background, is staged in the free slot, and becomes live on the next launch. A mandatory release reloads as soon as the download and verification finish, so the user is on it within the session. Use it for a release that fixes something you cannot leave running, and be aware that a reload discards whatever in-memory state the app had.

The flag lives on the release row and the admin API accepts a change to it later, so a release can be made mandatory after the fact — the devices that already installed it are unaffected, and the ones that have not yet will reload on arrival.

:::caution
On Android the reload swaps the bundle loader by reflection. If that fails the SDK rolls the state back and reports `ERR_OTA_RELOAD_UNSUPPORTED`, and the release applies on the next launch instead — a mandatory release degrades to a normal one rather than pretending it reloaded. This path has not been exercised on a physical device; see [Known limitations](/reference/limitations/).
:::

## A rollout in practice

```bash
ota publish -c production --rollout 5      # publish narrow
ota metrics -c production                  # read the funnel
ota rollout v42 25                         # widen
ota rollout v42 100                        # ship it
```

Nothing about the release changes between those steps — same bytes, same digest, same manifest. Only the threshold moves.
