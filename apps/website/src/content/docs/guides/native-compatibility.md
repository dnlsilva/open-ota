---
title: Native compatibility
description: Why a release is pinned to a fingerprint and a build floor, and what an OTA update can and cannot change.
---

An OTA update replaces JavaScript and assets inside a binary that is already installed. If the JavaScript expects a native module the binary does not have, the app crashes — and it crashes for everyone who received the update, on a build you cannot recall from the store.

Open OTA makes that structurally impossible rather than a rule someone has to remember. Two independent guards: a fingerprint, and a floor.

## runtimeVersion is a fingerprint

`runtimeVersion` is `fp_` plus the hash `@expo/fingerprint` computes over the native project — dependencies, native config, Podfile, Gradle files, the plugin list, everything that changes what the binary can do.

```bash
ota fingerprint
```

```
✔ Wrote fingerprint.json — fp_9c1b3e7a44d2b0f1…
Commit it: this is the contract between a bundle and the binaries allowed to run it.
```

`fingerprint.json` is committed. It holds the runtime version, the raw hash, when it was generated, and how many sources went into it.

Three details that matter:

- **`@expo/fingerprint` is resolved from your project, never from the CLI.** The hash has to reflect your dependency graph and your fingerprint version; a copy pinned inside the CLI would silently produce a different number than your own tooling.
- **Publishing stamps the committed fingerprint, not a fresh one.** Recomputing at publish time would happily stamp a fingerprint that no installed binary has, producing a release nobody can receive.
- **The match is exact.** No ranges, no semver, no policy to configure. The update-check filters on equality, and the native download path re-checks `manifest.runtimeVersion` against the value baked into the binary before extracting anything.

Change a native dependency and the fingerprint changes, so releases built against the old one stop being offered to the new build — and vice versa — with no action from you.

### In CI

```bash
ota fingerprint --check
```

Fails if `fingerprint.json` is missing, and fails if the project no longer hashes to it:

```
✘ Fingerprint drift: fingerprint.json says 9c1b3e7a44d2, the project hashes to
  44a201f8c003.
  The native project changed. Run `ota fingerprint`, commit it, and ship a new
  binary — old OTA releases no longer match this build.
```

Run it on every pull request. Drift caught in CI is a five-minute fix; drift caught after a release is a build that quietly stops receiving updates.

## The embedded floor id

The fingerprint alone leaves one hole. Ship a new binary whose native project did not change — a JavaScript-only release cut as a store build — and it has the same fingerprint as the old one. Every OTA release ever published against that fingerprint is a valid candidate, including ones older than the JavaScript inside the new binary. The device would "update" backwards.

So each build stamps an `embeddedFloorId`: a UUIDv7 generated at prebuild time and written into the binary. UUIDv7 sorts by creation time as plain text, and release ids are UUIDv7 too, so a string comparison is a chronological one.

The device sends the floor on every check. The server never offers a release with `id <= floor`. The native download path refuses one anyway, with `release predates the embedded bundle`. And the boot path sweeps state for anything below the floor, so a bundle staged before an app upgrade is discarded rather than promoted into a binary that has newer code inside it.

Three enforcement points for one rule, because the cost of the rule failing is a downgrade nobody asked for.

## Hermes

The published bundle is the `expo export` output — Hermes bytecode plus assets. Bytecode is tied to the Hermes version that ships with your React Native version, and loading it into a different Hermes is not a graceful failure.

That needs no special handling, because the React Native version is part of the fingerprint. Change React Native, change Hermes, change the fingerprint, and old bytecode stops being offered. The general mechanism covers the specific hazard.

## What an update can and cannot change

**Can:** anything inside the `expo export` output. JavaScript and TypeScript, React components, business logic, strings and translations, styles, and the assets the bundle references.

**Cannot:** native code of any kind. New or upgraded native dependencies, permissions, entitlements, the app icon, the display name, `Info.plist` and `AndroidManifest` entries, the minimum OS version, the React Native version, Hermes itself. Those change the fingerprint, which is precisely how the platform stops you from shipping them over the air.

That boundary is a platform rule, not a limitation of this project. Both Apple and Google permit updating interpreted JavaScript in an installed app; neither permits replacing native code. Everything here is built to stay on the correct side of that line automatically.

:::caution
Whether React Native resolves `require`d images from an updated bundle has not been measured on a device. JavaScript-only changes should be fine; adding or changing an image may not be. The archive deliberately preserves the export layout, because `metadata.json` is the only thing mapping a hashed file back to what the bundle asks for. See [Known limitations](/reference/limitations/).
:::
