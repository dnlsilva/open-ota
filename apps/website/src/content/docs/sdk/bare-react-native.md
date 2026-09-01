---
title: Bare React Native
description: What ota init writes into a checked-in android/ and ios/ tree, how to verify it, and the manual edits if you would rather do it yourself.
---

A bare project has no prebuild, so there is nothing to inject into. `ota init` applies the same four edits directly to the native files you have committed.

```bash
npm install @open-ota/react-native
npx @open-ota/cli init
npx @open-ota/cli fingerprint
npx @open-ota/cli doctor
```

```
✔ Wrote /Users/you/app/ota.config.json
✔ Patched the native boot path (MainApplication / AppDelegate) and the deep link scheme.
```

The codemods ship inside `@open-ota/react-native` and are loaded from your project, not from the CLI — so `ota publish` keeps working in a repository that never installed the SDK.

## Which files

| File | Found at |
|---|---|
| `MainApplication.kt` or `.java` | under `android/app/src/main`, searched by name |
| `AndroidManifest.xml` | `android/app/src/main/AndroidManifest.xml` |
| `AppDelegate.swift`, `.mm` or `.m` | under `ios/`, searched by name |
| `Info.plist` | under `ios/`, searched by name |

`node_modules`, `build`, `Pods`, `.git` and `DerivedData` are skipped.

## Idempotent by markers

Every edit sits between a pair of marker comments:

```kotlin
// @open-ota-begin jsBundleFile
override fun getJSBundleFile(): String? = OpenOta.getBundleFile(application)
// @open-ota-end jsBundleFile
```

XML and plist files get the `<!-- @open-ota-begin … -->` form. Re-running `ota init` finds the block, compares it, and rewrites it only when a value changed. Running it twice changes nothing, and an upgrade that alters a value updates one block instead of appending a second copy.

The markers are also what makes verification possible without guessing.

## Verifying

`ota doctor` checks every assumption the SDK makes at runtime, and the native wiring is one of them:

```
✔ ota.config.json — /Users/you/app/ota.config.json
✔ credentials — https://ota.example.com
✔ API reachable — https://ota.example.com
✔ token valid
✔ project resolves — Acme (0198f3a2-…)
✔ public key matches server
✔ native wiring — boot path patched
✔ fingerprint — fp_9c1b3e7a44d2b0f1…
✔ expo-updates absent
```

Underneath, the codemods re-run the same transforms with the result thrown away and report one check per modification — `android.import`, `android.jsBundleFile`, `android.reactHost`, `android.meta`, `android.deeplink`, `ios.import`, `ios.bundleURL`, `ios.meta`, `ios.urlScheme` — each with a status:

- **applied** — the marker block is in place.
- **missing** — the anchor is there and untouched. Run `ota init` again.
- **conflicting** — something else already owns the boot path. `HotUpdater`, `CodePush`, `expo.modules.updates`, `EXUpdates`, `RCTUpdates` and `UpdatesController` are all recognised by name. Nothing is written; remove the other library first, because two owners of the JS bundle is undefined behaviour.
- **notApplicable** — the modification does not apply to this template. An Old Architecture project has no `reactHost` getter to rewrite, and a project with no deep link scheme needs no intent filter.

`--json` prints the same information as structured output for CI.

## The manual edits

If you would rather not run a codemod, these are the two entry points that matter. Everything else — the manifest meta-data, the plist keys, the URL scheme — is configuration you can copy from [the Expo page](/sdk/installation/), using the same key names.

**`MainApplication.kt`**, inside the `ReactNativeHost`:

```kotlin
import dev.openota.OpenOta

override val reactNativeHost: ReactNativeHost =
  object : DefaultReactNativeHost(this) {
    override fun getJSBundleFile(): String? = OpenOta.getBundleFile(application)

    // …the rest of the template
  }
```

Java:

```java
import dev.openota.OpenOta;

@Override
protected String getJSBundleFile() {
  return OpenOta.getBundleFile(getApplication());
}
```

`getBundleFile` returns an absolute path, or `null` for the bundle inside the binary. It is synchronous and touches no network — it only reads local state. Returning `null` is the correct answer, not a failure, so never substitute a default of your own.

**`AppDelegate.swift`**, at the top of `bundleURL()`:

```swift
import OpenOta

override func bundleURL() -> URL? {
  #if !DEBUG
    if let otaURL = OpenOta.bundleURL() { return otaURL }
  #endif
  // …whatever your template already returned
}
```

Objective-C, in `bundleURL` or `sourceURLForBridge:`:

```objc
@import OpenOta;

- (NSURL *)bundleURL {
  #if !DEBUG
    NSURL *otaURL = [OpenOta bundleURL];
    if (otaURL != nil) { return otaURL; }
  #endif
  // …whatever your template already returned
}
```

The `#if !DEBUG` guard is why Metro keeps working in development, and prepending rather than replacing is why your template's own fallback survives.

:::note
On a bridgeless Android template the `reactHost` getter also has to be built from the same `ReactNativeHost`, or the New Architecture path will load the bundle the old getter pointed at. `ota init` rewrites that getter for you; if you are wiring it by hand, make sure the host you construct inherits the `getJSBundleFile` override above.
:::

## Both architectures

The bundle-swapping mechanism itself does not depend on the architecture — the difference is entirely in which function the platform calls at boot. `getJSBundleFile()` covers the bridge and the `ReactHost` derived from it; the `reactHost` getter covers a bridgeless template that builds its own. On iOS, `bundleURL()` and `sourceURL(for:)` are the two shapes the templates have used.

Nothing here has run on a physical device yet, on either architecture. See [Known limitations](/reference/limitations/).
