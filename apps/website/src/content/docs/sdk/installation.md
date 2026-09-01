---
title: Installation (Expo)
description: Installing the SDK in an Expo project, what the config plugin injects at prebuild, and why a dev build is required.
---

```bash
npx expo install @open-ota/react-native @expo/fingerprint
npx @open-ota/cli init
```

`ota init` creates or links a project, writes `ota.config.json`, and adds the plugin entry to `app.json`. Then:

```bash
ota fingerprint      # stamp the native compatibility hash and commit it
npx expo prebuild    # inject the native boot path
ota doctor           # confirm the wiring took
```

## The plugin entry

```json
{
  "expo": {
    "scheme": "myapp",
    "plugins": [
      ["@open-ota/react-native", {
        "projectId": "0198f3a2-6c41-7e19-9a30-2b7c5d1e4f80",
        "apiUrl": "https://ota.example.com",
        "channel": "production",
        "scheme": "myapp"
      }]
    ]
  }
}
```

The plugin reads these options first, then falls back to `ota.config.json` and `fingerprint.json`, both of which `ota init` and `ota fingerprint` write and you commit.

| Option | Falls back to | Notes |
|---|---|---|
| `projectId` | `ota.config.json` | required |
| `apiUrl` | `ota.config.json` | required |
| `appKey` | `ota.config.json` | required; the project's public app key, which identifies the app to the Device API |
| `publicKey` | `ota.config.json` | required; the project's RSA public key, PEM or bare base64 |
| `channel` | `ota.config.json`, then `"production"` | the channel this build asks for |
| `scheme` | `ota.config.json`, then `expo.scheme` | deep link scheme for preview links |
| `runtimeVersion` | `fingerprint.json` | the fingerprint hash; do not set this by hand |

Missing `apiUrl`, `appKey`, `projectId` or `publicKey` fails the prebuild with the list of what is absent. A missing runtime version fails with a pointer to `ota fingerprint` — updates are matched to the binary by that hash, so there is nothing sensible to do without it.

`embeddedFloorId` is not an option. The plugin mints a fresh UUIDv7 on every prebuild, because it is the release floor and has to move with the binary. See [Native compatibility](/guides/native-compatibility/).

`ota init` only rewrites `app.json`. If your project uses `app.config.js` or `app.config.ts` it prints the entry to paste instead — evaluating and re-emitting your own code is a worse trade than four lines of copying.

## What prebuild injects

Four edits, two of them code and two of them configuration.

**MainApplication** — `getJSBundleFile()` on the `ReactNativeHost`, which feeds the bridge and the `ReactHost` derived from it, plus a rewrite of the `reactHost` getter so a bridgeless template loads from the same place. Both architectures, one boot path.

**AppDelegate** — a prepend to `bundleURL()` (or `sourceURL(for:)`) guarded by `#if !DEBUG`, so Metro stays in charge during development and whatever fallback the template shipped with is preserved.

**AndroidManifest** — the project's identity as `<meta-data>` on `<application>`:

```
dev.openota.API_URL            dev.openota.PUBLIC_KEY
dev.openota.APP_KEY            dev.openota.EMBEDDED_FLOOR_ID
dev.openota.PROJECT_ID         dev.openota.DEEP_LINK_SCHEME
dev.openota.CHANNEL            dev.openota.RUNTIME_VERSION
```

plus, when a scheme is set, an intent filter on the launcher activity for `<scheme>://ota` with `VIEW`, `DEFAULT` and `BROWSABLE`.

**Info.plist** — the same values under their `OpenOta` keys, plus a `CFBundleURLTypes` entry named `dev.openota.preview` carrying the scheme.

PEM armor is stripped from the public key at build time; both platforms want the DER bytes.

The code edits go through the same marker-delimited transforms `ota init` applies to a bare project, so re-running prebuild is a no-op. The manifest and plist go through Expo's XML and plist object APIs instead, because Expo's own base mods re-serialize those files.

## Wire the app

```tsx
import { OpenOta, OtaProvider } from "@open-ota/react-native";

export default OpenOta.wrap(function App() {
  return <OtaProvider>{/* your app */}</OtaProvider>;
});
```

That is the whole integration. `<OtaProvider>` syncs on mount and confirms a healthy launch after the first frame. See the [JavaScript API](/sdk/api/) for the props and the escape hatches.

## Expo Go cannot work

Open OTA replaces the JavaScript bundle a binary loads at boot. That requires native code inside the binary — a custom module, and an edit to the file that decides which bundle to load. Expo Go is a fixed binary shipped by Expo; nothing can be added to it, and its boot path is not yours to change.

Calling the SDK without the native module throws with the reason:

```
Open OTA: native module not found. Rebuild the app (expo prebuild && expo run:ios/android,
or `ota init` for bare React Native) — this SDK cannot run over a JS-only reload.
```

Use a development build, or a release build. `isNativeModuleAvailable()` lets you branch in code that has to run in both.

## expo-updates is mutually exclusive

Two libraries taking over the JS bundle at boot is undefined behaviour: whichever wins the boot path decides what runs, and their rollback state diverges. The plugin fails the prebuild rather than letting that ship, and it names what it found — the dependency in `package.json`, the plugin entry, or an `updates.url` in the app config.

```
[@open-ota/react-native] expo-updates is also configured (expo-updates is in
package.json; "updates.url" is set in the app config).
Both libraries take over the JS bundle at boot, so only one can be installed.
```

`ota doctor` reports the same conflict without needing a prebuild.
