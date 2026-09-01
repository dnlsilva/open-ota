---
title: Telemetry and metrics
description: How adoption is measured with one row per device and a daily counter per release, and what is deliberately not collected.
---

The measurement design starts from a cost target: **O(devices) + O(releases × days), never O(events)**. Everything else follows from that.

## The update check is the heartbeat

Every launch already calls `/api/v1/update-check` with the device id, the release it is running, its channel, its native version and its runtime version. Measuring active users needs no second request, no analytics SDK and no separate endpoint — the request that decides what to install is the same request that records that the device exists.

## One row per device

`touchDevice` upserts a single row per device. The update only fires when the row is stale or something actually changed:

```sql
where last_seen_at < now() - interval '1 hour'
   or current_release_id is distinct from $new
   or native_version    is distinct from $new
   or runtime_version   is distinct from $new
   or channel <> $new
```

At 100,000 devices opening the app a few times a day that is tens of writes per second, not hundreds. A million devices is the same shape ten times over. The row holds first seen, last seen, platform, channel, native version, runtime version and current release — enough for every distribution question, and nothing that grows over time.

Rows untouched for 180 days are pruned.

## Daily counters per release

Device events fold into per-release, per-day counters in `release_stats`, applied as one increment statement per batch:

```sql
insert into release_stats (release_id, day, ready) values ($1, current_date, 1)
on conflict (release_id, day) do update set ready = release_stats.ready + excluded.ready;
```

Releases × active days is a few hundred rows. The daily series gives the adoption-over-time chart for free.

## What each funnel stage means

| Stage | Written when |
|---|---|
| `download` | the bundle was fetched, its signature and digest verified, and it was extracted into a slot |
| `install` | the update was applied — staged for the next launch, or reloaded if mandatory |
| `ready` | `notifyAppReady()` ran, so the new bundle booted and confirmed itself |
| `failed` | verification failed, or a rollback happened |
| `rollback` | the device reverted off a release |

A rollback increments **both** `rollbacks` and `failed`. That is not double counting: a rollback *is* a failed install of that release, and counting it in both places is what makes the funnel add up on the dashboard. Reading `download → install → ready` as a shrinking sequence only works if the drop-off appears somewhere.

Two derived rates, rounded to one decimal:

```
successRate  = ready     / installs
rollbackRate = rollbacks / installs
```

Rollbacks are also stored raw in `rollback_events` — release, the release it fell back to, device, reason and platform, kept for 90 days. It is the only raw event table, because rollbacks are rare and are the first thing anyone wants during an incident.

## Active means seen in the window

"Active devices" is always *devices whose `last_seen_at` falls inside the window*, and the window is shown rather than implied. The default is 30 days:

```bash
ota metrics -c production --window 30
```

```
production · 12480 devices seen in 30d
RELEASE  PLATFORM  DEVICES  DOWNLOADS  INSTALLS  READY  FAILED  ROLLBACKS  SUCCESS  ROLLBACK
    v42  ios          6210       6301      6288   6262      26         26    99.6%      0.4%
    v42  android      6270       6355      6341   6318      23         23    99.6%      0.4%

Version distribution
RELEASE   PLATFORM  DEVICES  % OF BASE  INSTALLS  ROLLBACKS
     v42  ios          6210      49.8%      6288         26
     v41  ios           190       1.5%     14022         31
embedded  android        44       0.4%         0          0
```

`embedded` is a device running the bundle inside its binary — no OTA release applied. A native version table follows the same shape, which is how you see binary fragmentation separately from OTA fragmentation.

## How events reach the server

Events are queued on the device, batched at most 50 per request, and sent to `POST /api/v1/events`. The queue holds 200 events and drops the oldest beyond that. It flushes on launch and when the app leaves the foreground.

Only a network error, a 5xx or a 429 requeues a batch, with backoff from 30 seconds doubling to a 5-minute ceiling. Anything the server answered — 2xx or 4xx — is discarded rather than retried, because duplicating a whole batch is worse than losing one.

Pass a store to survive a cold launch:

```tsx
import AsyncStorage from "@react-native-async-storage/async-storage";
import { OpenOta } from "@open-ota/react-native";

OpenOta.configure({ store: AsyncStorage });
```

Without one the queue is memory-only.

Counters are therefore **at least once**: a retried batch can double-count a few units. Device counts are exact, because they are rows rather than increments. That trade is deliberate — operational counters do not need to be billing-grade.

## What is deliberately not collected

- **No per-event log.** There is no row per download or per install. You cannot replay a funnel per device or build an arbitrary cohort after the fact, and adding that later means a separate store consuming the same events, not a change to the hot path.
- **No sessions, screens or timings.** This is not an analytics product. It answers which release a device is on and whether that release is healthy.
- **An anonymous device id.** A random UUID minted on first launch and kept in the app's own data. No hardware identifier, no advertising id, no fingerprinting. It disappears on reinstall — that is a real accuracy cost and the better privacy trade.
- **No PII.** The schema has nowhere to put a user id, an email or a location, because nothing sends one.
