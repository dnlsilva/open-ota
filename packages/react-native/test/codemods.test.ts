import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);

interface Check {
  id: string;
  status: "applied" | "missing" | "conflicting" | "notApplicable";
  file?: string;
  reason?: string;
}
interface PatchResult {
  contents: string;
  changed: boolean;
  checks: Check[];
}
type Config = Record<string, string | undefined>;

const edits = require_("../plugin/codemods/edits.js") as {
  derBase64(pem: string): string;
  patchMainApplication(contents: string, options?: Config): PatchResult;
  patchAppDelegate(contents: string, options?: Config): PatchResult;
  patchAndroidManifest(contents: string, config?: Config): PatchResult;
  patchInfoPlist(contents: string, config?: Config): PatchResult;
};

const codemods = require_("../plugin/codemods/index.js") as {
  applyAndroid(root: string, config?: Config): Check[];
  applyIos(root: string, config?: Config): Check[];
  verify(root: string): { ok: boolean; checks: Check[] };
};

const { uuidv7 } = require_("../plugin/uuidv7.js") as { uuidv7(now?: number): string };

const CONFIG: Config = {
  apiUrl: "https://ota.example.com",
  appKey: "pk_a1b2",
  projectId: "prj_1",
  channel: "production",
  runtimeVersion: "fp_9f8e7d",
  publicKey: "-----BEGIN PUBLIC KEY-----\nMIIBIjAN\nAQAB\n-----END PUBLIC KEY-----\n",
  embeddedFloorId: "0193a4c8-0000-7000-8000-000000000000",
  scheme: "myapp",
};

/* -------------------------------------------------------------- fixtures */

const MAIN_APPLICATION_KT = `package com.example.app

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultReactNativeHost
import expo.modules.ReactNativeHostWrapper

class MainApplication : Application(), ReactApplication {

  override val reactNativeHost: ReactNativeHost =
      ReactNativeHostWrapper(
          this,
          object : DefaultReactNativeHost(this) {
            override fun getPackages(): List<ReactPackage> {
              return PackageList(this).packages
            }

            override fun getJSMainModuleName(): String = ".expo/.virtual-metro-entry"

            override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG
          })

  override val reactHost: ReactHost
    get() = ReactNativeHostWrapper.createReactHost(applicationContext, reactNativeHost)

  override fun onCreate() {
    super.onCreate()
  }
}
`;

const MAIN_APPLICATION_BRIDGE_ONLY_KT = MAIN_APPLICATION_KT.replace(
  /  override val reactHost: ReactHost\n    get\(\) = .*\n/,
  "",
);

const APP_DELEGATE_SWIFT = `import ExpoModulesCore
import UIKit

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")
#else
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
`;

const ANDROID_MANIFEST = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application android:name=".MainApplication" android:label="@string/app_name">
    <activity android:name=".MainActivity" android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
      </intent-filter>
    </activity>
  </application>
</manifest>
`;

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>CFBundleDisplayName</key>
	<string>Example</string>
	<key>CFBundleShortVersionString</key>
	<string>1.4.2</string>
</dict>
</plist>
`;

/** Applying twice must produce exactly the same file as applying once. */
function twice(patch: (input: string, config?: Config) => PatchResult, source: string) {
  const first = patch(source, CONFIG);
  const second = patch(first.contents, CONFIG);
  return { first, second };
}

function statusOf(checks: Check[], id: string): string | undefined {
  return checks.find((check) => check.id === id)?.status;
}

/* ---------------------------------------------------------------- Android */

describe("MainApplication", () => {
  it("injects the bridge and bridgeless boot paths once", () => {
    const { first, second } = twice(edits.patchMainApplication, MAIN_APPLICATION_KT);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.contents).toBe(first.contents);

    expect(first.contents.match(/OpenOta\.getBundleFile/g)).toHaveLength(1);
    expect(first.contents.match(/OpenOta\.createReactHost/g)).toHaveLength(1);
    expect(first.contents.match(/import dev\.openota\.OpenOta/g)).toHaveLength(1);
    expect(statusOf(second.checks, "android.jsBundleFile")).toBe("applied");
    expect(statusOf(second.checks, "android.reactHost")).toBe("applied");
  });

  it("keeps the original getter in a comment so the edit is reversible", () => {
    const { first } = twice(edits.patchMainApplication, MAIN_APPLICATION_KT);
    expect(first.contents).toContain(
      "// replaced: ReactNativeHostWrapper.createReactHost(applicationContext, reactNativeHost)",
    );
  });

  it("reports the bridgeless path as not applicable on an Old Architecture template", () => {
    const result = edits.patchMainApplication(MAIN_APPLICATION_BRIDGE_ONLY_KT, CONFIG);
    expect(statusOf(result.checks, "android.jsBundleFile")).toBe("missing");
    expect(statusOf(result.checks, "android.reactHost")).toBe("notApplicable");
    expect(result.contents).toContain("OpenOta.getBundleFile");
  });

  it("refuses to fight another library over the bundle", () => {
    const taken = MAIN_APPLICATION_KT.replace(
      "override fun getJSMainModuleName",
      "override fun getJSBundleFile(): String? = HotUpdater.getJSBundleFile(this)\n            override fun getJSMainModuleName",
    );
    const result = edits.patchMainApplication(taken, CONFIG);
    expect(statusOf(result.checks, "android.jsBundleFile")).toBe("conflicting");
    expect(result.contents).not.toContain("OpenOta.getBundleFile");
  });

  it("emits Java syntax for a Java template", () => {
    const java = `package com.example.app;

import android.app.Application;

public class MainApplication extends Application implements ReactApplication {
  private final ReactNativeHost mReactNativeHost = new DefaultReactNativeHost(this) {
    @Override
    public boolean getUseDeveloperSupport() { return BuildConfig.DEBUG; }
  };
}
`;
    const result = edits.patchMainApplication(java, { language: "java" });
    expect(result.contents).toContain("import dev.openota.OpenOta;");
    expect(result.contents).toContain("return OpenOta.getBundleFile(getApplication());");
  });
});

describe("AndroidManifest", () => {
  it("writes the meta-data and the ota deep link exactly once", () => {
    const { first, second } = twice(edits.patchAndroidManifest, ANDROID_MANIFEST);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(first.contents.match(/dev\.openota\.API_URL/g)).toHaveLength(1);
    expect(first.contents.match(/android:host="ota"/g)).toHaveLength(1);
    expect(first.contents).toContain('android:name="dev.openota.EMBEDDED_FLOOR_ID"');
    expect(first.contents).toContain('android:scheme="myapp"');
  });

  it("stores the public key as bare base64 DER", () => {
    const { first } = twice(edits.patchAndroidManifest, ANDROID_MANIFEST);
    expect(first.contents).toContain('android:value="MIIBIjANAQAB"');
    expect(first.contents).not.toContain("BEGIN PUBLIC KEY");
  });

  it("refreshes values when the config changes, without a second block", () => {
    const first = edits.patchAndroidManifest(ANDROID_MANIFEST, CONFIG);
    const moved = edits.patchAndroidManifest(first.contents, { ...CONFIG, channel: "staging" });
    expect(moved.changed).toBe(true);
    expect(moved.contents.match(/dev\.openota\.CHANNEL/g)).toHaveLength(1);
    expect(moved.contents).toContain('android:name="dev.openota.CHANNEL" android:value="staging"');
  });
});

/* -------------------------------------------------------------------- iOS */

describe("AppDelegate", () => {
  it("prepends the OTA bundle lookup to bundleURL once", () => {
    const { first, second } = twice(edits.patchAppDelegate, APP_DELEGATE_SWIFT);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(first.contents.match(/OpenOta\.bundleURL\(\)/g)).toHaveLength(1);
    expect(first.contents.match(/^import OpenOta$/gm)).toHaveLength(1);
    // Metro still owns the bundle in development.
    expect(first.contents).toContain("#if !DEBUG");
    expect(first.contents).toContain('return Bundle.main.url(forResource: "main"');
  });

  it("patches an Objective-C AppDelegate", () => {
    const objc = `#import "AppDelegate.h"
#import <React/RCTBundleURLProvider.h>

@implementation AppDelegate

- (NSURL *)bundleURL
{
  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
}

@end
`;
    const result = edits.patchAppDelegate(objc, { language: "objcpp" });
    expect(result.contents).toContain("@import OpenOta;");
    expect(result.contents).toContain("NSURL *otaURL = [OpenOta bundleURL];");
    expect(edits.patchAppDelegate(result.contents, { language: "objcpp" }).changed).toBe(false);
  });
});

describe("Info.plist", () => {
  it("adds the keys and the URL scheme once", () => {
    const { first, second } = twice(edits.patchInfoPlist, INFO_PLIST);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(first.contents.match(/<key>OpenOtaApiUrl<\/key>/g)).toHaveLength(1);
    expect(first.contents.match(/<key>CFBundleURLTypes<\/key>/g)).toHaveLength(1);
    expect(first.contents).toContain("<string>myapp</string>");
    expect(first.contents).toContain("<string>MIIBIjANAQAB</string>");
    expect(first.contents.indexOf("<key>OpenOtaApiUrl</key>")).toBeLessThan(
      first.contents.lastIndexOf("</dict>"),
    );
  });

  it("appends into an existing CFBundleURLTypes array instead of duplicating the key", () => {
    const withScheme = INFO_PLIST.replace(
      "</dict>",
      `	<key>CFBundleURLTypes</key>
	<array>
		<dict>
			<key>CFBundleURLSchemes</key>
			<array>
				<string>existing</string>
			</array>
		</dict>
	</array>
</dict>`,
    );
    const result = edits.patchInfoPlist(withScheme, CONFIG);
    expect(result.contents.match(/<key>CFBundleURLTypes<\/key>/g)).toHaveLength(1);
    expect(result.contents).toContain("<string>existing</string>");
    expect(result.contents).toContain("<string>myapp</string>");
    expect(edits.patchInfoPlist(result.contents, CONFIG).changed).toBe(false);
  });
});

/* -------------------------------------------------- bare project end to end */

describe("bare React Native project", () => {
  const roots: string[] = [];

  function fixtureProject(pkg: Record<string, unknown> = { dependencies: {} }): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-ota-"));
    roots.push(root);
    const android = path.join(root, "android", "app", "src", "main");
    fs.mkdirSync(path.join(android, "java", "com", "example"), { recursive: true });
    fs.writeFileSync(path.join(android, "java", "com", "example", "MainApplication.kt"), MAIN_APPLICATION_KT);
    fs.writeFileSync(path.join(android, "AndroidManifest.xml"), ANDROID_MANIFEST);
    const ios = path.join(root, "ios", "Example");
    fs.mkdirSync(ios, { recursive: true });
    fs.writeFileSync(path.join(ios, "AppDelegate.swift"), APP_DELEGATE_SWIFT);
    fs.writeFileSync(path.join(ios, "Info.plist"), INFO_PLIST);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
    return root;
  }

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("reports every modification as missing before init and applied after", () => {
    const root = fixtureProject();
    const before = codemods.verify(root);
    expect(before.ok).toBe(false);
    expect(statusOf(before.checks, "android.jsBundleFile")).toBe("missing");
    expect(statusOf(before.checks, "ios.bundleURL")).toBe("missing");
    expect(statusOf(before.checks, "android.meta")).toBe("missing");
    expect(statusOf(before.checks, "ios.urlScheme")).toBe("notApplicable");

    codemods.applyAndroid(root, CONFIG);
    codemods.applyIos(root, CONFIG);

    const after = codemods.verify(root);
    expect(after.ok).toBe(true);
    expect(after.checks.every((c) => c.status === "applied" || c.status === "notApplicable")).toBe(true);
    expect(after.checks.map((c) => c.id)).toContain("ios.urlScheme");
  });

  it("is idempotent on disk", () => {
    const root = fixtureProject();
    codemods.applyAndroid(root, CONFIG);
    codemods.applyIos(root, CONFIG);
    const snapshot = codemods
      .verify(root)
      .checks.map((c) => c.file)
      .filter((file): file is string => Boolean(file))
      .map((file) => fs.readFileSync(file, "utf8"));

    codemods.applyAndroid(root, CONFIG);
    codemods.applyIos(root, CONFIG);
    const again = codemods
      .verify(root)
      .checks.map((c) => c.file)
      .filter((file): file is string => Boolean(file))
      .map((file) => fs.readFileSync(file, "utf8"));
    expect(again).toEqual(snapshot);
  });

  it("flags expo-updates as a conflict", () => {
    const root = fixtureProject({ dependencies: { "expo-updates": "~0.25.0" } });
    const result = codemods.verify(root);
    expect(result.ok).toBe(false);
    expect(statusOf(result.checks, "expo-updates")).toBe("conflicting");
  });

  it("reports missing files rather than throwing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-ota-empty-"));
    roots.push(root);
    const result = codemods.verify(root);
    expect(result.ok).toBe(false);
    expect(result.checks.every((c) => c.status === "missing")).toBe(true);
  });
});

describe("embedded floor id", () => {
  it("is a time-ordered UUIDv7 so the server can compare it to release ids", () => {
    const early = uuidv7(1_700_000_000_000);
    const late = uuidv7(1_800_000_000_000);
    expect(early[14]).toBe("7");
    expect(["8", "9", "a", "b"]).toContain(early[19]);
    expect(early < late).toBe(true);
    expect(uuidv7()).not.toBe(uuidv7());
  });
});
