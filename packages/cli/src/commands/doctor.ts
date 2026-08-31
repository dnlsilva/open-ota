import type { Command } from "commander";
import { dim, green, red, yellow } from "kleur/colors";
import { OtaApiError, OtaClient } from "@open-ota/shared";

import { PROJECT_CONFIG_FILE, readJson, resolveConfig, type ResolvedConfig } from "../config.js";
import { computeFingerprint, loadFingerprintModule, readFingerprint } from "../fingerprint.js";
import { EXIT_FAILURE, print, printJson } from "../output.js";
import {
  appConfigPath,
  detectAppKind,
  hasExpoUpdates,
  loadCodemods,
  PLUGIN_PACKAGE,
  type AppJson,
} from "../project.js";

type Status = "pass" | "fail" | "skip";

interface Check {
  name: string;
  status: Status;
  detail?: string;
}

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("check config, connectivity, native wiring and fingerprint")
    .option("--project <id>", "override the configured project id")
    .option("--json", "print as JSON")
    .action(async (flags: { project?: string; json?: boolean }) => {
      const config = resolveConfig({ projectId: flags.project });
      const checks = await runChecks(config);

      if (flags.json) {
        printJson({ ok: checks.every((check) => check.status !== "fail"), checks });
      } else {
        for (const check of checks) {
          print(`${icon(check.status)} ${check.name}${check.detail ? dim(` — ${check.detail}`) : ""}`);
        }
      }

      if (checks.some((check) => check.status === "fail")) process.exitCode = EXIT_FAILURE;
    });
}

async function runChecks(config: ResolvedConfig): Promise<Check[]> {
  const checks: Check[] = [];
  const { projectRoot, project } = config;

  checks.push(
    project
      ? { name: PROJECT_CONFIG_FILE, status: "pass", detail: config.projectConfigPath }
      : { name: PROJECT_CONFIG_FILE, status: "fail", detail: `not found in ${projectRoot}; run \`ota init\`` },
  );

  if (project && !project.publicKey) {
    checks.push({
      name: "public key",
      status: "fail",
      detail: "missing from ota.config.json; the app cannot verify manifests without it",
    });
  }

  if (!config.apiUrl || !config.token) {
    checks.push({ name: "credentials", status: "fail", detail: "run `ota login`, or set OTA_API_URL/OTA_TOKEN" });
    checks.push({ name: "API reachable", status: "skip", detail: "no credentials" });
    checks.push({ name: "project resolves", status: "skip", detail: "no credentials" });
  } else {
    checks.push({ name: "credentials", status: "pass", detail: config.apiUrl });
    checks.push(...(await apiChecks(config)));
  }

  checks.push(await wiringCheck(config));
  checks.push(await fingerprintCheck(projectRoot));
  checks.push(
    hasExpoUpdates(projectRoot)
      ? {
          name: "expo-updates absent",
          status: "fail",
          detail: "expo-updates also owns the JS bundle — remove it, or Open OTA updates will not stick",
        }
      : { name: "expo-updates absent", status: "pass" },
  );

  return checks;
}

async function apiChecks(config: ResolvedConfig): Promise<Check[]> {
  const client = new OtaClient({ baseUrl: config.apiUrl as string, token: config.token });

  try {
    await client.listProjects();
  } catch (error) {
    if (error instanceof OtaApiError) {
      return [
        { name: "API reachable", status: "pass", detail: config.apiUrl },
        {
          name: "token valid",
          status: "fail",
          detail: error.status === 401 ? "rejected — run `ota login`" : `${error.code}: ${error.message}`,
        },
        { name: "project resolves", status: "skip", detail: "token invalid" },
      ];
    }
    return [
      { name: "API reachable", status: "fail", detail: `${config.apiUrl} did not answer` },
      { name: "token valid", status: "skip", detail: "API unreachable" },
      { name: "project resolves", status: "skip", detail: "API unreachable" },
    ];
  }

  const checks: Check[] = [
    { name: "API reachable", status: "pass", detail: config.apiUrl },
    { name: "token valid", status: "pass" },
  ];

  if (!config.projectId) {
    checks.push({ name: "project resolves", status: "skip", detail: "no project id configured" });
    return checks;
  }

  try {
    const { project } = await client.getProject(config.projectId);
    const keyMatches = !config.publicKey || config.publicKey.trim() === project.publicKey.trim();
    checks.push({ name: "project resolves", status: "pass", detail: `${project.name} (${project.id})` });
    checks.push(
      keyMatches
        ? { name: "public key matches server", status: "pass" }
        : {
            name: "public key matches server",
            status: "fail",
            detail: "ota.config.json is stale — re-run `ota init` and rebuild the app",
          },
    );
  } catch (error) {
    checks.push({
      name: "project resolves",
      status: "fail",
      detail: error instanceof OtaApiError ? error.message : String(error),
    });
  }

  return checks;
}

async function wiringCheck(config: ResolvedConfig): Promise<Check> {
  const { projectRoot } = config;
  const kind = detectAppKind(projectRoot);

  if (kind === "bare") {
    const codemods = await loadCodemods(projectRoot);
    if (!codemods) {
      return { name: "native wiring", status: "skip", detail: `${PLUGIN_PACKAGE} is not installed here` };
    }
    if (typeof codemods.verify !== "function") {
      return { name: "native wiring", status: "skip", detail: "installed SDK has no verify()" };
    }
    const result = await codemods.verify({
      projectRoot,
      projectId: config.projectId ?? "",
      apiUrl: config.apiUrl ?? "",
      channel: config.channel,
      scheme: config.deepLinkScheme,
      publicKey: config.publicKey,
    });
    const failures = (result.checks ?? []).filter((check) => !check.ok);
    return result.ok
      ? { name: "native wiring", status: "pass", detail: "boot path patched" }
      : {
          name: "native wiring",
          status: "fail",
          detail: failures.map((check) => check.message ?? check.name).join("; ") || "run `ota init` again",
        };
  }

  if (kind === "expo") {
    const path = appConfigPath(projectRoot);
    if (!path?.endsWith("app.json")) {
      return { name: "native wiring", status: "skip", detail: "app.config.* is not inspected — check it by hand" };
    }
    const plugins = readJson<AppJson>(path)?.expo?.plugins ?? [];
    const present = plugins.some((entry) => (Array.isArray(entry) ? entry[0] : entry) === PLUGIN_PACKAGE);
    return present
      ? { name: "native wiring", status: "pass", detail: `plugin registered in ${path}` }
      : { name: "native wiring", status: "fail", detail: `${PLUGIN_PACKAGE} missing from app.json plugins` };
  }

  return { name: "native wiring", status: "skip", detail: "not an Expo or bare React Native project" };
}

async function fingerprintCheck(projectRoot: string): Promise<Check> {
  const committed = readFingerprint(projectRoot);
  if (!committed) {
    return { name: "fingerprint", status: "fail", detail: "no fingerprint.json — run `ota fingerprint`" };
  }
  if (!(await loadFingerprintModule(projectRoot))) {
    return {
      name: "fingerprint",
      status: "skip",
      detail: `@expo/fingerprint not installed; cannot verify ${committed.runtimeVersion}`,
    };
  }
  const current = await computeFingerprint(projectRoot);
  return current.hash === committed.hash
    ? { name: "fingerprint", status: "pass", detail: committed.runtimeVersion }
    : {
        name: "fingerprint",
        status: "fail",
        detail: `drifted: committed ${committed.hash.slice(0, 12)}, project hashes to ${current.hash.slice(0, 12)}`,
      };
}

function icon(status: Status): string {
  if (status === "pass") return green("✔");
  if (status === "fail") return red("✘");
  return yellow("–");
}
