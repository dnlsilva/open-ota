---
title: Telemetry costs
description: Why measuring adoption costs O(devices) + O(releases × days) instead of O(events), and what the numbers look like.
---

The premise: never store a raw event per user. Everything below follows from
that one decision.

## The shape of the cost

Cost is **O(devices) + O(releases × days)**, never O(events).

- **The update-check is the heartbeat.** Every launch already asks the server
  what it should be running, carrying the device id, the release it is on and
  its native version. Measuring active users needs no extra request and no
  analytics endpoint.
- **One row per installation.** The device row is upserted on that same
  request, written at most hourly and only when something changed.
- **One row per release per day.** The funnel lives in counters —
  `downloads`, `installs`, `ready`, `failed`, `rollbacks` — incremented with a
  single upsert per batch. Releases times active days is a few hundred rows,
  which also gives the adoption-over-time chart for free.

The only raw events kept are rollbacks: rare, and the first thing anyone wants
during an incident.

## The load, at 100k devices

Assuming roughly five app opens per device per day:

| Load | Value | Note |
|---|---|---|
| update-check | ~500k/day ≈ 6 req/s (peak ~60) | indexed read plus a throttled upsert |
| device writes | ≤ 1 per device per hour ≈ 10/s at peak | only when older than an hour or the state changed |
| counter increments | tens per second on a release day | upsert into `release_stats` |
| bundle downloads | CDN, never touches the server | the server only signs metadata |

One node and a small Postgres cover that with room to spare. **One million
devices is the same shape ten times over** — still one solid node and Postgres
with the right indexes. A `devices` table with a million rows is unremarkable.

## The throttle rule

The device upsert only writes when at least one of these is true:

- `lastSeenAt` is more than an hour old
- `currentReleaseId` differs from what is stored
- `nativeVersion` differs
- `runtimeVersion` differs
- `channel` differs

The interval is `DEVICE_TOUCH_THROTTLE_MS`, one hour. Everything else is a
no-op at the database level, which is what keeps writes in the tens per second
rather than the hundreds while every device still checks in on every launch.

## Precision

Counters are **at-least-once**. The SDK queues events on disk and retries, so a
batch that was delivered but whose response was lost gets re-sent and counted
twice. That is the accepted trade for not keeping an event log: a rollback rate
that is a fraction of a percent out is still the number you act on, and this is
how CodePush operated for years.

Device counts are exact — one row per installation, counted directly. So
"8,250 devices, 82.5% of base" is precise, while "3,417 downloads" is
approximately right.

The definition of active is explicit: a device whose `lastSeenAt` falls inside
the window, 30 days by default.

## Retention

| Data | Policy |
|---|---|
| `devices` | pruned when `lastSeenAt` is older than 180 days |
| `release_stats` | kept indefinitely — the table is tiny |
| `rollback_events` | 90 days |
| bundles in storage | immutable; collecting old disabled releases is future work |

:::caution
`pruneDevices` is implemented and takes the 180-day cutoff as its default, but
nothing schedules it yet, and the 90-day expiry on `rollback_events` is a
documented policy with no job behind it. Both are a cron entry away; until you
add one, neither table is trimmed.
:::

## When to change any of this

Documented triggers, and not before:

| Signal | Action |
|---|---|
| Contention on the counter upsert, past roughly 500 events/s | Buffer in memory with a 5-second flush, or Redis `INCR` flushed every minute |
| The distribution query gets slow, well past a million devices | A materialised view refreshed every 5 minutes |
| Deep analysis — per-device funnels, cohorts | ClickHouse alongside, fed by the same events, leaving the hot path untouched |
| Bundle upload becomes the bottleneck | Presigned upload with asynchronous hash verification |

There is no cache and no queue today. A Postgres upsert absorbs the projected
telemetry load, and Redis earns its place only at that first threshold. The
same reasoning keeps the Device API and the Admin API in one process, in
separate routers: splitting them is mechanical when traffic justifies it, and
until then it would double the deployment for a system doing single-digit
requests per second.
