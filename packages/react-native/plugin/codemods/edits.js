"use strict";
/**
 * Pure string transforms on the native host files, shared by the Expo config
 * plugin and the bare React Native codemods. No fs and no dependencies: `ota
 * init` has to run in a project that never installed @expo/config-plugins.
 *
 * Every edit sits between marker comments, which is what makes re-running
 * prebuild (or `ota init`) a no-op and lets `ota doctor` tell applied from
 * missing from conflicting.
 *
 * Each patch returns { contents, changed, checks } where a check's `status`
 * describes the file *before* the edit — so verify() is the same code path
 * with the result thrown away.
 */

const BEGIN = "@open-ota-begin";
const END = "@open-ota-end";

/** meta-data names read by the Android native module. */
const ANDROID_META = {
  apiUrl: "dev.openota.API_URL",
  appKey: "dev.openota.APP_KEY",
  projectId: "dev.openota.PROJECT_ID",
  channel: "dev.openota.CHANNEL",
  runtimeVersion: "dev.openota.RUNTIME_VERSION",
  publicKey: "dev.openota.PUBLIC_KEY",
  embeddedFloorId: "dev.openota.EMBEDDED_FLOOR_ID",
  deepLinkScheme: "dev.openota.DEEP_LINK_SCHEME",
};

/** Info.plist keys read by the iOS native module. */
const IOS_PLIST = {
  apiUrl: "OpenOtaApiUrl",
  appKey: "OpenOtaAppKey",
  projectId: "OpenOtaProjectId",
  channel: "OpenOtaChannel",
  runtimeVersion: "OpenOtaRuntimeVersion",
  publicKey: "OpenOtaPublicKey",
  embeddedFloorId: "OpenOtaEmbeddedFloorId",
  deepLinkScheme: "OpenOtaDeepLinkScheme",
};

/** Another library already owning the boot path is a conflict, not a re-run. */
const COMPETING = /HotUpdater|CodePush|expo\.modules\.updates|EXUpdates|RCTUpdates|UpdatesController/;

/* ------------------------------------------------------------------ markers */

function block(id, lines, indent = "", comment = "//") {
  const open = comment === "<!--" ? `<!-- ${BEGIN} ${id} -->` : `${comment} ${BEGIN} ${id}`;
  const close = comment === "<!--" ? `<!-- ${END} ${id} -->` : `${comment} ${END} ${id}`;
  return [open, ...lines, close].map((line) => (line ? indent + line : line)).join("\n") + "\n";
}

/** Whole-line span of an existing marker block, or null. */
function findBlock(text, id) {
  const begin = text.indexOf(`${BEGIN} ${id}`);
  if (begin === -1) return null;
  const end = text.indexOf(`${END} ${id}`, begin);
  if (end === -1) return null;
  const start = text.lastIndexOf("\n", begin) + 1;
  const lineEnd = text.indexOf("\n", end);
  return { start, end: lineEnd === -1 ? text.length : lineEnd + 1 };
}

/** Replaces an existing block (values may have changed) or inserts a new one. */
function upsert(text, id, body, insertAt) {
  const existing = findBlock(text, id);
  if (existing) {
    const before = text.slice(existing.start, existing.end);
    if (before === body) return { contents: text, changed: false, status: "applied" };
    return {
      contents: text.slice(0, existing.start) + body + text.slice(existing.end),
      changed: true,
      status: "applied",
    };
  }
  if (insertAt < 0) return { contents: text, changed: false, status: "missing" };
  return {
    contents: text.slice(0, insertAt) + body + text.slice(insertAt),
    changed: true,
    status: "missing",
  };
}

function indentOf(text, index) {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const match = /^[ \t]*/.exec(text.slice(lineStart, index));
  return match ? match[0] : "";
}

function lineEndAfter(text, index) {
  const nl = text.indexOf("\n", index);
  return nl === -1 ? text.length : nl + 1;
}

/**
 * Insert whole lines *above* a closing tag rather than at its exact offset —
 * otherwise the tag loses its own indentation and the next run computes a
 * different one, which would make the edit look changed forever.
 */
function lineStartOf(text, index) {
  return index < 0 ? -1 : text.lastIndexOf("\n", index) + 1;
}

/* -------------------------------------------------------------- Android JVM */

/** Injects `import dev.openota.OpenOta` after the last existing import. */
function patchImport(contents, language) {
  const statement = language === "java" ? "import dev.openota.OpenOta;" : "import dev.openota.OpenOta";
  const lastImport = contents.lastIndexOf("\nimport ");
  const anchor =
    lastImport !== -1
      ? lineEndAfter(contents, lastImport + 1)
      : lineEndAfter(contents, contents.indexOf("package "));
  return upsert(contents, "import", block("import", [statement]), anchor);
}

/**
 * Boot path, Android. `getJSBundleFile()` feeds the bridge ReactNativeHost and,
 * on New Architecture, the ReactHost derived from it; the `reactHost` getter is
 * rewritten too so a bridgeless template loads from the same place.
 */
function patchMainApplication(contents, options = {}) {
  const language = options.language === "java" ? "java" : "kt";
  const checks = [];
  let out = contents;

  const imported = patchImport(out, language);
  out = imported.contents;
  checks.push({ id: "android.import", status: imported.status });

  // getJSBundleFile — bridge and derived ReactHost
  const hostAnchor =
    language === "java"
      ? /new\s+(?:Default)?ReactNativeHost\s*\([^)]*\)\s*\{/.exec(out)
      : /object\s*:\s*(?:Default)?ReactNativeHost\s*\([^)]*\)\s*\{/.exec(out);

  if (findBlock(out, "jsBundleFile")) {
    checks.push({ id: "android.jsBundleFile", status: "applied" });
  } else if (/getJSBundleFile/.test(out) || COMPETING.test(out)) {
    checks.push({ id: "android.jsBundleFile", status: "conflicting" });
  } else if (!hostAnchor) {
    checks.push({ id: "android.jsBundleFile", status: "missing", reason: "no ReactNativeHost" });
  } else {
    const at = hostAnchor.index + hostAnchor[0].length;
    const indent = indentOf(out, hostAnchor.index) + "  ";
    const lines =
      language === "java"
        ? [
            "@Override",
            "protected String getJSBundleFile() {",
            "  return OpenOta.getBundleFile(getApplication());",
            "}",
          ]
        : ["override fun getJSBundleFile(): String? = OpenOta.getBundleFile(application)"];
    out = out.slice(0, at) + "\n" + block("jsBundleFile", lines, indent) + out.slice(at);
    checks.push({ id: "android.jsBundleFile", status: "missing" });
  }

  // reactHost — bridgeless only; absent on Old Architecture templates
  const hostGetter =
    /([ \t]*)override\s+val\s+reactHost\s*:\s*ReactHost\s*(?:\r?\n[ \t]*)?get\(\)\s*=\s*([^\r\n]+)/.exec(
      out,
    );
  if (findBlock(out, "reactHost")) {
    checks.push({ id: "android.reactHost", status: "applied" });
  } else if (!hostGetter) {
    checks.push({ id: "android.reactHost", status: "notApplicable", reason: "bridge-only template" });
  } else if (COMPETING.test(hostGetter[2])) {
    checks.push({ id: "android.reactHost", status: "conflicting" });
  } else {
    const indent = hostGetter[1];
    const replacement = block(
      "reactHost",
      [
        `// replaced: ${hostGetter[2].trim()}`,
        "override val reactHost: ReactHost",
        "  get() = OpenOta.createReactHost(applicationContext, reactNativeHost)",
      ],
      indent,
    );
    out =
      out.slice(0, hostGetter.index) +
      replacement.replace(/\n$/, "") +
      out.slice(hostGetter.index + hostGetter[0].length);
    checks.push({ id: "android.reactHost", status: "missing" });
  }

  return { contents: out, changed: out !== contents, checks };
}

/* ------------------------------------------------------------------- iOS */

/** Index just past the `{` that opens the body of the first matching function. */
function bodyStart(contents, signatures) {
  for (const signature of signatures) {
    const match = signature.exec(contents);
    if (!match) continue;
    const brace = contents.indexOf("{", match.index + match[0].length - 1);
    if (brace !== -1) return lineEndAfter(contents, brace);
  }
  return -1;
}

/**
 * Boot path, iOS. Prepending to bundleURL() rather than rewriting its
 * `#if DEBUG` branches keeps whatever fallback the template shipped with, and
 * `#if !DEBUG` keeps Metro in charge during development.
 */
function patchAppDelegate(contents, options = {}) {
  const objc = options.language === "objc" || options.language === "objcpp";
  const checks = [];
  let out = contents;

  const importStatement = objc ? "@import OpenOta;" : "import OpenOta";
  const lastImport = objc
    ? Math.max(out.lastIndexOf("\n#import "), out.lastIndexOf("\n@import "))
    : out.lastIndexOf("\nimport ");
  const importAnchor = lastImport === -1 ? 0 : lineEndAfter(out, lastImport + 1);
  const imported = upsert(out, "import", block("import", [importStatement]), importAnchor);
  out = imported.contents;
  checks.push({ id: "ios.import", status: imported.status });

  const anchors = objc
    ? [/-\s*\(NSURL\s*\*\)\s*bundleURL/, /-\s*\(NSURL\s*\*\)\s*sourceURLForBridge:/]
    : [/func\s+bundleURL\s*\(\s*\)\s*->\s*URL\?/, /func\s+sourceURL\s*\(\s*for\s+bridge/];

  if (findBlock(out, "bundleURL")) {
    checks.push({ id: "ios.bundleURL", status: "applied" });
    return { contents: out, changed: out !== contents, checks };
  }
  if (COMPETING.test(out)) {
    checks.push({ id: "ios.bundleURL", status: "conflicting" });
    return { contents: out, changed: out !== contents, checks };
  }

  const at = bodyStart(out, anchors);
  if (at < 0) {
    checks.push({ id: "ios.bundleURL", status: "missing", reason: "no bundleURL override" });
    return { contents: out, changed: out !== contents, checks };
  }

  const indent = "  ";
  const lines = objc
    ? ["#if !DEBUG", "  NSURL *otaURL = [OpenOta bundleURL];", "  if (otaURL != nil) { return otaURL; }", "#endif"]
    : ["#if !DEBUG", "  if let otaURL = OpenOta.bundleURL() { return otaURL }", "#endif"];
  out = out.slice(0, at) + block("bundleURL", lines, indent) + out.slice(at);
  checks.push({ id: "ios.bundleURL", status: "missing" });

  return { contents: out, changed: out !== contents, checks };
}

/* ---------------------------------------------------------------- manifests */

/** PEM armor is ceremony: both platforms want the DER bytes. */
function derBase64(publicKey) {
  if (!publicKey) return "";
  return publicKey.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
}

function metaValues(config) {
  return {
    apiUrl: config.apiUrl,
    appKey: config.appKey,
    projectId: config.projectId,
    channel: config.channel,
    runtimeVersion: config.runtimeVersion,
    publicKey: derBase64(config.publicKey),
    embeddedFloorId: config.embeddedFloorId,
    deepLinkScheme: config.scheme,
  };
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function patchAndroidManifest(contents, config = {}) {
  const values = metaValues(config);
  const checks = [];
  let out = contents;

  const metaLines = Object.entries(ANDROID_META)
    .filter(([key]) => values[key] !== undefined && values[key] !== null && values[key] !== "")
    .map(
      ([key, name]) =>
        `<meta-data android:name="${name}" android:value="${escapeXml(values[key])}" />`,
    );
  const appClose = out.indexOf("</application>");
  // The Expo plugin writes these through the XML object API, which drops our
  // comments — so presence of the key itself also counts as applied.
  const meta =
    !findBlock(out, "meta") && out.includes(`android:name="${ANDROID_META.apiUrl}"`)
      ? { contents: out, changed: false, status: "applied" }
      : upsert(
          out,
          "meta",
          block("meta", metaLines, indentOf(out, appClose) + "  ", "<!--"),
          lineStartOf(out, appClose),
        );
  out = meta.contents;
  checks.push({ id: "android.meta", status: meta.status });

  // Deep link: <scheme>://ota/* on the launcher activity.
  const mainIndex = out.indexOf("android.intent.action.MAIN");
  const activityClose = mainIndex === -1 ? -1 : out.indexOf("</activity>", mainIndex);
  const scheme = config.scheme;
  const filterLines = scheme
    ? [
        "<intent-filter>",
        '  <action android:name="android.intent.action.VIEW" />',
        '  <category android:name="android.intent.category.DEFAULT" />',
        '  <category android:name="android.intent.category.BROWSABLE" />',
        `  <data android:scheme="${escapeXml(scheme)}" android:host="ota" />`,
        "</intent-filter>",
      ]
    : [];
  const filter =
    !scheme && !findBlock(out, "deeplink")
      ? { contents: out, changed: false, status: "notApplicable" }
      : !findBlock(out, "deeplink") && out.includes('android:host="ota"')
        ? { contents: out, changed: false, status: "applied" }
        : upsert(
            out,
            "deeplink",
            block("deeplink", filterLines, indentOf(out, activityClose) + "  ", "<!--"),
            lineStartOf(out, activityClose),
          );
  out = filter.contents;
  checks.push({ id: "android.deeplink", status: filter.status });

  return { contents: out, changed: out !== contents, checks };
}

function patchInfoPlist(contents, config = {}) {
  const values = metaValues(config);
  const checks = [];
  let out = contents;

  const metaLines = [];
  for (const [key, plistKey] of Object.entries(IOS_PLIST)) {
    const value = values[key];
    if (value === undefined || value === null || value === "") continue;
    metaLines.push(`<key>${plistKey}</key>`, `<string>${escapeXml(value)}</string>`);
  }
  const dictClose = out.lastIndexOf("</dict>");
  const meta =
    !findBlock(out, "meta") && out.includes(`<key>${IOS_PLIST.apiUrl}</key>`)
      ? { contents: out, changed: false, status: "applied" }
      : upsert(
          out,
          "meta",
          block("meta", metaLines, indentOf(out, dictClose) + "\t", "<!--"),
          lineStartOf(out, dictClose),
        );
  out = meta.contents;
  checks.push({ id: "ios.meta", status: meta.status });

  const scheme = config.scheme;
  const urlTypeDict = scheme
    ? [
        "<dict>",
        "\t<key>CFBundleURLName</key>",
        "\t<string>dev.openota.preview</string>",
        "\t<key>CFBundleURLSchemes</key>",
        "\t<array>",
        `\t\t<string>${escapeXml(scheme)}</string>`,
        "\t</array>",
        "</dict>",
      ]
    : [];
  // Only a CFBundleURLTypes we did not write ourselves changes the strategy;
  // otherwise a second run would flip branches and rewrite its own block.
  const own = findBlock(out, "urlScheme");
  const keyIndex = out.indexOf("<key>CFBundleURLTypes</key>");
  const foreignKey =
    keyIndex !== -1 && !(own && keyIndex >= own.start && keyIndex < own.end) ? keyIndex : -1;

  let schemeResult;
  if (!scheme && !own) {
    schemeResult = { contents: out, changed: false, status: "notApplicable" };
  } else if (!own && out.includes("<string>dev.openota.preview</string>")) {
    schemeResult = { contents: out, changed: false, status: "applied" };
  } else if (foreignKey !== -1) {
    // Append into the array that is already there — a second key would be invalid.
    const arrayOpen = out.indexOf("<array>", foreignKey);
    schemeResult = upsert(
      out,
      "urlScheme",
      block("urlScheme", urlTypeDict, indentOf(out, arrayOpen) + "\t", "<!--"),
      arrayOpen === -1 ? -1 : lineEndAfter(out, arrayOpen),
    );
  } else {
    const anchor = out.lastIndexOf("</dict>");
    schemeResult = upsert(
      out,
      "urlScheme",
      block(
        "urlScheme",
        ["<key>CFBundleURLTypes</key>", "<array>", ...urlTypeDict.map((l) => "\t" + l), "</array>"],
        indentOf(out, anchor) + "\t",
        "<!--",
      ),
      lineStartOf(out, anchor),
    );
  }
  out = schemeResult.contents;
  checks.push({ id: "ios.urlScheme", status: schemeResult.status });

  return { contents: out, changed: out !== contents, checks };
}

module.exports = {
  BEGIN,
  END,
  ANDROID_META,
  IOS_PLIST,
  derBase64,
  patchMainApplication,
  patchAppDelegate,
  patchAndroidManifest,
  patchInfoPlist,
};
