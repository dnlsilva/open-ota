---
title: JavaScript API
description: The exported surface of @open-ota/react-native — provider, sync, status, events and the escape hatches.
---

```tsx
import { OpenOta, OtaProvider } from "@open-ota/react-native";
```

`OpenOta` is also the default export. Every method returns a promise unless noted.

## OpenOta.wrap and OtaProvider

`OpenOta.wrap(App, options?)` is the zero-config form of `<OtaProvider>`; both take the same props.

```tsx
export default OpenOta.wrap(function App() {
  return <OtaProvider>{/* your app */}</OtaProvider>;
});
```

| Prop | Default | Effect |
|---|---|---|
| `syncOnLaunch` | `true` | runs `sync()` once on mount |
| `autoNotifyReady` | `true` | calls `notifyAppReady()` just after the first frame |
| `onSyncResult` | — | receives the `SyncResult` from the launch sync |
| `renderProgress` | — | rendered above `children` while a bundle downloads |

The provider also installs the preview deep-link handler.

**Auto-confirm and how to opt out.** Until `notifyAppReady()` runs, the native side treats the launch as a crash and reverts on the next start. The default fires on the frame after the first paint — late enough to prove React mounted, early enough that a slow screen does not look like a crash. If your app should only count as healthy once its own first data load succeeded:

```tsx
<OtaProvider autoNotifyReady={false}>{children}</OtaProvider>
```

and call `OpenOta.notifyAppReady()` yourself. Forgetting to is a rollback loop, not a silent no-op.

## sync()

```ts
const result = await OpenOta.sync();
```

Check, download and apply in one call. **It never throws** — a failed sync must not take the app down with it. Every outcome is a value:

| Result | Meaning |
|---|---|
| `{ status: "upToDate" }` | already on the target release, or nothing to install |
| `{ status: "updated", release, mandatory, reloaded }` | downloaded and staged; `reloaded` is true when it applied immediately |
| `{ status: "rolledBack" }` | the server pulled the running release; the device is back on the embedded bundle |
| `{ status: "pinned" }` | a preview is active, so the check was skipped entirely |
| `{ status: "incompatible", runtimeVersion }` | the offered release needs a different native build |
| `{ status: "error", error }` | network, timeout or native failure |

`release` is `{ id, label }`. The check is aborted after 10 seconds by default — a slow network must never delay a launch.

## checkForUpdate()

```ts
const response = await OpenOta.checkForUpdate();
if (response.action === "update") {
  await OpenOta.downloadUpdate(response, /* reload */ false);
}
```

The raw server answer, with no side effects: `{ action: "none" }`, `{ action: "rollBackToEmbedded" }`, or `{ action: "update", mandatory, manifest, signature, url }`. Unlike `sync()`, this one throws on a transport failure. Use it when you want to show a prompt before downloading; `downloadUpdate()` is its counterpart.

## notifyAppReady() and getStatus()

`notifyAppReady()` confirms the running bundle actually booted, clears the watchdog flag, and records a `ready` event. Idempotent — calling it when no verification is pending does nothing.

```ts
const status = await OpenOta.getStatus();
```

```ts
{
  deviceId: string;          // anonymous UUID, minted on first launch
  channel: string;           // the runtime override if set, else the build's channel
  runtimeVersion: string;    // the fingerprint baked into the binary
  nativeVersion: string;     // the app's own version string
  currentRelease: { id, label } | null;   // null = running the embedded bundle
  pendingRelease: { id, label } | null;   // downloaded, applies on the next launch
  failedReleases: string[];  // sent on every update-check
  isPreview: boolean;        // pinned by a preview link
}
```

## setChannel()

```ts
await OpenOta.setChannel("staging");
await OpenOta.sync();
```

Persists a channel override that outranks the one baked into the binary. Pass `null` or `""` to clear it. It does not itself trigger a check — see [Channels and promotion](/guides/channels/) for what the next check does.

## reload() and exitPreview()

`reload()` restarts the JavaScript runtime, applying a staged release immediately. On Android the bundle loader is swapped by reflection; if that fails the SDK restores its previous state and rejects with `ERR_OTA_RELOAD_UNSUPPORTED` rather than reloading the old bundle while claiming the new one is live.

`exitPreview()` leaves preview mode so the normal update-check resumes. While a preview is pinned, `sync()` returns `{ status: "pinned" }` without contacting the server.

## configure()

```tsx
import AsyncStorage from "@react-native-async-storage/async-storage";

OpenOta.configure({ store: AsyncStorage });
```

| Option | Effect |
|---|---|
| `store` | anything with `getItem`/`setItem`; without it the telemetry queue is memory-only and a cold launch loses it |
| `apiUrl` | overrides the URL baked into the binary — local development only |
| `timeoutMs` | update-check timeout, default 10000 |
| `fetchImpl` | replaces `globalThis.fetch` |

## addListener()

```ts
const subscription = OpenOta.addListener("downloadProgress", (p) => {
  setPercent(p.fraction);
});
// later
subscription.remove();
```

| Event | Payload |
|---|---|
| `downloadProgress` | `{ releaseId, bytesWritten, totalBytes, fraction }` — `totalBytes` and `fraction` are 0 when the CDN sends no content-length |
| `updateState` | a tagged union: `downloading`, `downloaded`, `installed`, `ready`, `rollback`, `verifyFailed`, `error`, each with a `releaseId` |
| `previewRequested` | `{ url?, d?, s? }` from a `<scheme>://ota/preview` link |

`updateState` is where the native side reports outcomes JavaScript never sees — most importantly a rollback that happened during a boot the previous process did not survive.

## The rest of the surface

`clearFailed()` empties the device's failed-release list, which is a debugging tool rather than part of normal operation. `flushEvents()` forces a telemetry flush; launch and backgrounding already do it. `isNativeModuleAvailable()` reports whether the native module is present, which is how you branch in code that also has to run in Expo Go or in Node.

For tests and tooling the package also exports the pure pieces with no native dependency — `buildUpdateCheckUrl`, `updateCheckHeaders`, `planFrom`, `parsePreviewLink`, `handlePreviewRequest`, the `EventQueue` class, and `setNativeModule` as a test seam. Importing the package in Node is safe: the native module resolves to a stub that only throws if a method is actually called.
