---
title: Introduction
description: What Open OTA is, what it does, and the ideas it is built on.
---

Open OTA is a self-hosted platform for over-the-air updates in React Native and Expo apps. It publishes JavaScript and asset changes without an App Store or Play Store review, and — the part most update tools skip — it tells you what happened next: who received the update, who installed it, who came back up clean, and who rolled back.

```
v42  android  production   rollout 10%   4.8 MB   b94d27b9…
     8,250 devices · 82.5% of base · 99.6% ready · 0.4% rollback
```

## What you get

- **Signed releases.** Each project has its own RSA key pair. The device verifies the manifest signature and the bundle digest before a single byte executes, so a compromised CDN cannot inject code.
- **Automatic rollback.** A release that crashes before the app confirms a healthy launch is reverted on the next start — one strike — and is never offered to that device again.
- **Gradual rollout.** Deterministic bucketing by device and release. Raising a percentage only ever adds devices.
- **Adoption you can read.** Active devices per OTA release and per native app version, funnel, rollback rate, adoption over time — at a cost that stays flat as you grow.
- **Native compatibility, structurally.** Releases are pinned to a native fingerprint and a build floor, so an update can never land on a binary that cannot run it.
- **Preview on a real phone.** A signed deep link, rendered as a QR code, installs one exact release on one device without touching the global rollout.
- **MCP built in.** Agents connect to the server over HTTP with OAuth, or to the CLI over stdio, and operate everything in natural language.

## The one mechanism underneath

The server answers a single question — *which release should this device be running?* — and the SDK converges on the answer. Converging **up** is an update. Converging **down** happens when the release a device runs was disabled. Converging to the **embedded bundle** is the final fallback. Update, remote rollback and recovery are all the same code path, which is why each of them is boring.

## Where it runs

One codebase, one Postgres schema, three targets: a Supabase Edge Function, a Cloudflare Worker, or plain Docker on your own machine. Storage is an adapter — R2, S3, MinIO or Supabase Storage — and any CDN can sit in front, because bundles are immutable.

`OTA_MODE=hosted` turns the same server into a multi-tenant service with organisations, plans, quotas and Stripe. The default mode is a single organisation with no billing and no metering.

## Project status

Pre-release. The server, SDK, CLI, dashboard and MCP endpoint are implemented and covered by tests, including an end-to-end suite that runs the real migrations on a real Postgres engine in-process. What has not happened yet is the part only hardware settles: nothing has run on a physical phone. The [known limitations](/reference/limitations/) page keeps the honest list.
