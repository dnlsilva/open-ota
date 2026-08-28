"use strict";
/**
 * Bare React Native setup: the same native edits the Expo config plugin makes
 * at prebuild, applied straight to a checked-in android/ and ios/ tree.
 *
 *   applyAndroid(projectRoot, config) / applyIos(projectRoot, config)  → `ota init`
 *   verify(projectRoot)                                               → `ota doctor`
 *
 * Idempotent through the marker comments in ./edits.js, so running init twice
 * changes nothing and doctor can report applied / missing / conflicting per
 * modification.
 */

const fs = require("node:fs");
const path = require("node:path");
const {
  patchAndroidManifest,
  patchAppDelegate,
  patchInfoPlist,
  patchMainApplication,
} = require("./edits.js");

const SKIP_DIRS = new Set(["node_modules", "build", "Pods", ".git", "DerivedData"]);

function findFile(root, matches, depth = 6) {
  if (depth < 0 || !fs.existsSync(root)) return null;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isFile() && matches(entry.name)) return path.join(root, entry.name);
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
    const found = findFile(path.join(root, entry.name), matches, depth - 1);
    if (found) return found;
  }
  return null;
}

function locate(projectRoot) {
  const android = path.join(projectRoot, "android", "app", "src", "main");
  const ios = path.join(projectRoot, "ios");
  return {
    mainApplication: findFile(android, (n) => n === "MainApplication.kt" || n === "MainApplication.java"),
    androidManifest: fs.existsSync(path.join(android, "AndroidManifest.xml"))
      ? path.join(android, "AndroidManifest.xml")
      : null,
    appDelegate: findFile(
      ios,
      (n) => n === "AppDelegate.swift" || n === "AppDelegate.mm" || n === "AppDelegate.m",
      3,
    ),
    infoPlist: findFile(ios, (n) => n === "Info.plist", 3),
  };
}

function languageOf(file) {
  const ext = path.extname(file);
  if (ext === ".java") return "java";
  if (ext === ".kt") return "kt";
  if (ext === ".swift") return "swift";
  return "objcpp";
}

function run(file, patch, config, write) {
  if (!file) return [{ id: patch.id, status: "missing", reason: "file not found" }];
  const before = fs.readFileSync(file, "utf8");
  const result = patch.fn(before, { language: languageOf(file), ...config });
  if (write && result.changed) fs.writeFileSync(file, result.contents);
  return result.checks.map((check) => ({ ...check, file }));
}

function applyAndroid(projectRoot, config = {}, options = {}) {
  const files = locate(projectRoot);
  const write = options.write !== false;
  return [
    ...run(files.mainApplication, { id: "android.mainApplication", fn: patchMainApplication }, config, write),
    ...run(files.androidManifest, { id: "android.manifest", fn: patchAndroidManifest }, config, write),
  ];
}

function applyIos(projectRoot, config = {}, options = {}) {
  const files = locate(projectRoot);
  const write = options.write !== false;
  return [
    ...run(files.appDelegate, { id: "ios.appDelegate", fn: patchAppDelegate }, config, write),
    ...run(files.infoPlist, { id: "ios.infoPlist", fn: patchInfoPlist }, config, write),
  ];
}

function hasExpoUpdates(projectRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
    return Boolean(pkg.dependencies?.["expo-updates"] ?? pkg.devDependencies?.["expo-updates"]);
  } catch {
    return false;
  }
}

/**
 * Read-only counterpart of apply*: same transforms, results discarded. A check
 * is `applied` when its marker block is in place, `missing` when the anchor is
 * there but untouched, `conflicting` when something else owns the boot path.
 */
function verify(projectRoot) {
  const checks = [
    ...applyAndroid(projectRoot, {}, { write: false }),
    ...applyIos(projectRoot, {}, { write: false }),
  ];
  if (hasExpoUpdates(projectRoot)) {
    checks.push({
      id: "expo-updates",
      status: "conflicting",
      reason: "expo-updates is installed and also owns the JS bundle; remove it",
    });
  }
  return { ok: checks.every((c) => c.status === "applied" || c.status === "notApplicable"), checks };
}

module.exports = { applyAndroid, applyIos, verify, locate };
