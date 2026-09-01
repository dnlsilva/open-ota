---
title: Known limitations
description: What has not been validated yet, why each item is open, and what would close it.
---

The server, SDK, CLI, dashboard and MCP endpoint are implemented and covered by
tests, including a suite that runs the real migrations against a real Postgres
engine in-process. What has not happened yet is the part only hardware can
settle: nothing here has run on a phone.

Four things are open.

## 1. Asset resolution is unverified

This is the open question. A release is the `expo export` output zipped as-is,
and the native side finds the bundle through `metadata.json`. Whether React
Native then resolves `require`d images from an updated bundle still has to be
measured on a device. JavaScript-only changes should be fine; adding or
changing an image may not be.

:::caution
Do not flatten the archive to "fix" this without measuring first.
`metadata.json` is the only thing mapping a hashed file back to what the bundle
asks for, and throwing that away to make the tree prettier removes the
information asset resolution needs.
:::

**What would close it:** publish a release that adds a new image and one that
changes an existing one, install both on a real iOS and a real Android device,
and confirm the images render from the updated bundle rather than the embedded
one. If they do not, the fix is in how the extracted slot is exposed to the
resolver — not in the archive layout.

## 2. Android reload swaps the bundle by reflection

Neither `ReactInstanceManager` nor `ReactHost` re-reads the bundle path on
reload, so the SDK swaps it by reflection. If the swap fails, the SDK rolls the
update back to pending and applies it on the next launch instead of pretending
it worked — the failure mode is a delay, not a wrong bundle.

Because it depends on private fields, it needs checking per React Native
version.

**What would close it:** run the reload path on each supported React Native
version, on both the bridge and bridgeless boot paths, and record which
versions take the in-place swap and which fall through to next-launch.

## 3. iOS cold-start deep links

Opening a preview link when the app is not already running relies on the host
`AppDelegate` forwarding `application(_:open:options:)` to `RCTLinkingManager`.
Templates that do not forward it will not deliver the link on a cold start.

Those projects can call `handlePreviewLink(url)` from JavaScript instead.

**What would close it:** scan a preview QR code against a fully terminated app
built from the current Expo template and from a bare template, and confirm the
release opens pinned in both.

## 4. The Docker image and the edge entries are unbuilt

The Node path was smoke-tested against a real Postgres. The `Dockerfile`, the
Supabase Edge Function and the Cloudflare Worker are typecheck- and
configuration-level only: they compile and the configuration is written, but
none has been deployed and exercised end to end.

**What would close it:** `docker compose up` on a clean host through a real
publish and a real update-check; `supabase functions deploy` and
`wrangler deploy` followed by the same round trip against each. The three
targets share `src/app.ts`, so what is actually being validated is the edge
around it — the entry, the bindings and the storage adapter.

## Validation matrix

Every cell is a device configuration nobody has run yet.

| | Old architecture | New architecture |
|---|---|---|
| Android (API 24, current) | not run | not run |
| iOS (15.1, current) | not run | not run |
| Expo prebuild | not run | not run |
| Bare React Native | not run | not run |

**What would close it:** the update, rollback and preview flows executed on
each row, on both architectures. The mechanism that swaps a bundle does not
depend on the architecture; the boot path does, which is why the matrix is
two columns wide rather than one.

## What is not on this list

These are settled, and it is worth being precise about the difference:

- The update-check decision is a pure function with tests covering the
  candidate rules, stickiness, the build floor and the failed list.
- Signing runs on Web Crypto only, identically on Node, Deno and Workers, with
  fixed vectors in `packages/shared/test/vectors/` keeping the Kotlin and Swift
  implementations in step.
- The migrations run against a real Postgres engine in-process, so the SQL under
  test is the SQL that ships.
- Both MCP transports bind to one shared contract, with a conformance test that
  fails if they drift.

None of that says anything about a phone. That is the point of this page.
