---
title: Preview on a device
description: How a signed deep link puts one exact release on one phone without touching the rollout.
---

"Open on device" hands a tester a QR code. They scan it, the app opens, and it is running that exact release — pinned, regardless of channel or rollout, and reversible with one call.

## The link

The dashboard asks the server for a preview link. The server builds a payload, signs it with the project's private key, and returns a deep link:

```json
{ "purpose": "preview", "projectId": "…", "releaseId": "…", "exp": 1767225600 }
```

```
myapp://ota/preview?d=<base64url payload>&s=<base64url signature>
```

The default lifetime is 15 minutes and the maximum is 24 hours. The project needs a deep link scheme configured, or the request fails with `no_deep_link_scheme` — there is nowhere for the link to open otherwise.

`purpose` is domain separation. It is what stops a preview token from ever being replayed as something else signed by the same key.

## Why knowing a release id is not enough

A release id is not a secret; it appears in logs, in CLI output, in the dashboard URL. If possessing one were enough to install a release, every internal build would be one leaked id away from being public.

The link is a capability, not an identifier. It carries a signature produced by a private key that never leaves the server, it is scoped to exactly one project and one release, and it expires. Editing the release id inside `d` invalidates the signature. Copying a link from another project fails the project check. Keeping one around fails the expiry check.

## What the SDK verifies

The native side verifies the token before anything touches the network — a forged link never becomes a request:

1. `d` decodes as base64url and parses as JSON with the expected shape;
2. `purpose` is exactly `"preview"`;
3. the signature verifies against the public key baked into the binary, over the canonical re-serialization of the payload;
4. `projectId` matches this binary's project;
5. `exp` has not passed, allowing 300 seconds of device clock skew.

Only then does the SDK fetch `GET /api/v1/preview/manifest?d=&s=` with the app key header. The server **revalidates the same token**, with zero skew tolerance, and returns the signed manifest for that release.

That second check is what makes the short expiry meaningful. The device is lenient about clocks because phones drift; the server has no such excuse. A link that is past its expiry stops working even though the device would have accepted it, which is why expiry doubles as revocation — you cannot un-send a QR code, but you can outlast it.

The manifest then goes through the normal install path: fingerprint check first, and if the release was built against a different native project the SDK refuses with something actionable rather than a hash mismatch:

```
This release needs a build with runtime fp_9c1b3e…; this device runs fp_44a201….
Install a matching build first.
```

Otherwise: download, verify the signature and the digest, extract, and reload immediately. Preview always reloads — someone is standing there holding a phone.

## Pinned mode

Once installed, the release is pinned. `state.json` records `previewReleaseId`, `getStatus().isPreview` becomes `true`, and `sync()` returns without contacting the server at all:

```ts
if (status.isPreview) return { status: "pinned" };
```

The normal update flow is suspended, so a tester on a preview build stays on it. Nothing in the rollout, and no publish to their channel, moves them.

```ts
await OpenOta.exitPreview();
await OpenOta.sync();
```

`exitPreview()` clears the pin and lets the update-check resume. A crash rollback also clears it, because a reverted device should go back to being a normal device.

## From the terminal

```bash
ota preview v42 --ttl 30
```

The QR is drawn in the terminal, followed by the link itself and the details:

```
█▀▀▀▀▀█ ▀▄█▀▄ █▀▀▀▀▀█
█ ███ █ ▀█▄▀▄ █ ███ █
█ ▀▀▀ █ █▄▀ ▄ █ ▀▀▀ █
▀▀▀▀▀▀▀ █ ▀ █ ▀▀▀▀▀▀▀

myapp://ota/preview?d=eyJwdXJwb3NlIjoicHJldmlldyIs…&s=Q2hlY2tlZC…
v42 · ios · expires 2026-09-01T14:32:11.000Z · opens via myapp://
The app must already be installed with a matching fingerprint; preview pins until exitPreview().
```

Add `--json` to get the release and link as JSON instead.

## Limits

The app has to be installed already. A preview link installs a JavaScript bundle into an existing binary — it cannot install the binary, and it cannot make a binary run a bundle built against a different native project.

:::caution
On iOS a cold start delivers the link through the launch options, which relies on the host `AppDelegate` forwarding `application(_:open:options:)` to `RCTLinkingManager`. Templates that do not can call `handlePreviewLink(url)` from JavaScript instead. This path is unverified on real hardware — see [Known limitations](/reference/limitations/).
:::
