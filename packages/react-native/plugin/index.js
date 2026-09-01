"use strict";
/**
 * Expo config plugin — everything the SDK needs at build time (ARCHITECTURE §3.3):
 * the boot path in MainApplication/AppDelegate, the project's identity and
 * public key in AndroidManifest/Info.plist, and the `<scheme>://ota/*` deep
 * link used by preview QR codes.
 *
 *   { "plugins": [["@open-ota/react-native", { "projectId": "...", "apiUrl": "..." }]] }
 *
 * Values not passed inline are read from ota.config.json (written by `ota init`)
 * and fingerprint.json (written by `ota fingerprint`), both committed.
 *
 * The two code edits go through plugin/codemods/edits.js — the same transforms
 * `ota init` applies to a bare project, marker-delimited and idempotent. The
 * manifest and plist go through Expo's XML/plist object API instead, because
 * Expo's own base mods re-serialize those files and would drop comments.
 */

const fs = require("node:fs");
const path = require("node:path");
const {
  createRunOncePlugin,
  withAndroidManifest,
  withAppDelegate,
  withInfoPlist,
  withMainApplication,
  AndroidConfig,
} = require("@expo/config-plugins");

const { ANDROID_META, IOS_PLIST, derBase64, patchAppDelegate, patchMainApplication } = require("./codemods/edits.js");
const { uuidv7 } = require("./uuidv7.js");
const pkg = require("../package.json");

const URL_NAME = "dev.openota.preview";

/* ---------------------------------------------------------------- options */

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function resolveOptions(config, props, projectRoot) {
  const file = readJson(path.join(projectRoot, "ota.config.json")) ?? {};
  const fingerprint = readJson(path.join(projectRoot, "fingerprint.json")) ?? {};
  const scheme = Array.isArray(config.scheme) ? config.scheme[0] : config.scheme;

  const options = {
    apiUrl: props.apiUrl ?? file.apiUrl,
    appKey: props.appKey ?? file.appKey,
    projectId: props.projectId ?? file.projectId,
    publicKey: props.publicKey ?? file.publicKey,
    channel: props.channel ?? file.channel ?? "production",
    scheme: props.scheme ?? file.deepLinkScheme ?? file.scheme ?? scheme,
    runtimeVersion: props.runtimeVersion ?? fingerprint.hash ?? fingerprint.fingerprint ?? file.runtimeVersion,
    // Fresh per build: this is the release floor, so it must move with the binary.
    embeddedFloorId: uuidv7(),
  };

  const missing = ["apiUrl", "appKey", "projectId", "publicKey"].filter((key) => !options[key]);
  if (missing.length > 0) {
    throw new Error(
      `[@open-ota/react-native] missing ${missing.join(", ")}. Run \`ota init\` to create ` +
        "ota.config.json, or pass the values inline in the plugin options.",
    );
  }
  if (!options.runtimeVersion) {
    throw new Error(
      "[@open-ota/react-native] missing runtimeVersion. Run `ota fingerprint` to write " +
        "fingerprint.json — updates are matched to the native build by that hash.",
    );
  }
  return options;
}

/**
 * Two libraries swapping the JS bundle is undefined behaviour: whichever wins
 * the boot path decides, and rollback state diverges. Fail loudly at prebuild.
 */
function assertNoExpoUpdates(config, projectRoot) {
  const listed = (config.plugins ?? []).some((entry) => {
    const name = Array.isArray(entry) ? entry[0] : entry;
    return name === "expo-updates";
  });
  const configured = Boolean(config.updates && config.updates.url);
  const pkgJson = readJson(path.join(projectRoot, "package.json")) ?? {};
  const installed = Boolean(
    pkgJson.dependencies?.["expo-updates"] ?? pkgJson.devDependencies?.["expo-updates"],
  );

  if (!listed && !configured && !installed) return;
  const reasons = [
    installed && "expo-updates is in package.json",
    listed && '"expo-updates" is listed in plugins',
    configured && '"updates.url" is set in the app config',
  ].filter(Boolean);

  throw new Error(
    `[@open-ota/react-native] expo-updates is also configured (${reasons.join("; ")}).\n` +
      "Both libraries take over the JS bundle at boot, so only one can be installed.\n" +
      "To use Open OTA: `npx expo install --fix` after removing expo-updates from\n" +
      'package.json, drop the "updates" key and the "expo-updates" plugin entry from\n' +
      "your app config, then re-run prebuild.",
  );
}

/* ------------------------------------------------------------------- mods */

function withBootPath(config) {
  config = withMainApplication(config, (cfg) => {
    const result = patchMainApplication(cfg.modResults.contents, {
      language: cfg.modResults.language,
    });
    assertApplied(result, "MainApplication");
    cfg.modResults.contents = result.contents;
    return cfg;
  });

  return withAppDelegate(config, (cfg) => {
    const result = patchAppDelegate(cfg.modResults.contents, {
      language: cfg.modResults.language,
    });
    assertApplied(result, "AppDelegate");
    cfg.modResults.contents = result.contents;
    return cfg;
  });
}

function assertApplied(result, file) {
  const conflict = result.checks.find((check) => check.status === "conflicting");
  if (conflict) {
    throw new Error(
      `[@open-ota/react-native] ${file} already hands the JS bundle to another library ` +
        `(${conflict.id}). Remove it before enabling Open OTA.`,
    );
  }
}

function setMetaData(mainApplication, name, value) {
  const items = (mainApplication["meta-data"] ?? []).filter(
    (item) => item.$?.["android:name"] !== name,
  );
  items.push({ $: { "android:name": name, "android:value": String(value) } });
  mainApplication["meta-data"] = items;
}

function withAndroidValues(config, options) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults;
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
    const values = {
      apiUrl: options.apiUrl,
      appKey: options.appKey,
      projectId: options.projectId,
      channel: options.channel,
      runtimeVersion: options.runtimeVersion,
      publicKey: derBase64(options.publicKey),
      embeddedFloorId: options.embeddedFloorId,
      deepLinkScheme: options.scheme,
    };
    for (const [key, name] of Object.entries(ANDROID_META)) {
      if (values[key]) setMetaData(application, name, values[key]);
    }

    if (options.scheme) {
      const activity = AndroidConfig.Manifest.getMainActivityOrThrow(manifest);
      const filters = (activity["intent-filter"] ?? []).filter(
        (filter) =>
          !(filter.data ?? []).some(
            (entry) => entry.$?.["android:scheme"] === options.scheme && entry.$?.["android:host"] === "ota",
          ),
      );
      filters.push({
        action: [{ $: { "android:name": "android.intent.action.VIEW" } }],
        category: [
          { $: { "android:name": "android.intent.category.DEFAULT" } },
          { $: { "android:name": "android.intent.category.BROWSABLE" } },
        ],
        data: [{ $: { "android:scheme": options.scheme, "android:host": "ota" } }],
      });
      activity["intent-filter"] = filters;
    }
    return cfg;
  });
}

function withIosValues(config, options) {
  return withInfoPlist(config, (cfg) => {
    const plist = cfg.modResults;
    plist[IOS_PLIST.apiUrl] = options.apiUrl;
    plist[IOS_PLIST.appKey] = options.appKey;
    plist[IOS_PLIST.projectId] = options.projectId;
    plist[IOS_PLIST.channel] = options.channel;
    plist[IOS_PLIST.runtimeVersion] = options.runtimeVersion;
    plist[IOS_PLIST.publicKey] = derBase64(options.publicKey);
    plist[IOS_PLIST.embeddedFloorId] = options.embeddedFloorId;

    if (options.scheme) {
      plist[IOS_PLIST.deepLinkScheme] = options.scheme;
      const types = plist.CFBundleURLTypes ?? [];
      const already = types.some((type) => (type.CFBundleURLSchemes ?? []).includes(options.scheme));
      if (!already) {
        types.push({ CFBundleURLName: URL_NAME, CFBundleURLSchemes: [options.scheme] });
      }
      plist.CFBundleURLTypes = types;
    }
    return cfg;
  });
}

const withOpenOta = (config, props = {}) => {
  const projectRoot = config._internal?.projectRoot ?? process.cwd();
  assertNoExpoUpdates(config, projectRoot);
  const options = resolveOptions(config, props, projectRoot);

  config = withBootPath(config);
  config = withAndroidValues(config, options);
  config = withIosValues(config, options);
  return config;
};

module.exports = createRunOncePlugin(withOpenOta, pkg.name, pkg.version);
module.exports.withOpenOta = withOpenOta;
module.exports.resolveOptions = resolveOptions;
module.exports.assertNoExpoUpdates = assertNoExpoUpdates;
