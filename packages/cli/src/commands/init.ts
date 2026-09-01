import type { Command } from "commander";
import { bold, dim } from "kleur/colors";
import { generateMasterKey, type OtaClient, type Project } from "@open-ota/shared";

import { createClient } from "../client.js";
import { DEFAULT_CHANNEL, resolveConfig, saveProjectConfig, type ProjectConfig } from "../config.js";
import { fail, note, ok, print, step, warn } from "../output.js";
import { ask } from "../prompt.js";
import {
  detectAppKind,
  hasExpoUpdates,
  loadCodemods,
  wireExpoPlugin,
  expoScheme,
  PLUGIN_PACKAGE,
  readPackageJson,
  type PluginOptions,
} from "../project.js";
import { getProvider, PROVIDER_NAMES, runProvision } from "../providers/index.js";

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("create or link a project, write ota.config.json and wire the app")
    .option("--provider <name>", `print/run backend provisioning: ${PROVIDER_NAMES.join(" | ")}`)
    .option("--project <id>", "use this project id instead of asking")
    .option("-c, --channel <name>", "default channel", DEFAULT_CHANNEL)
    .option("--scheme <scheme>", "deep link scheme for preview links")
    .option("--dry-run", "print provisioning steps without running them")
    .option("-y, --yes", "skip confirmations")
    .action(
      async (options: {
        provider?: string;
        project?: string;
        channel: string;
        scheme?: string;
        dryRun?: boolean;
        yes?: boolean;
      }) => {
        const config = resolveConfig({ projectId: options.project, channel: options.channel });
        const client = createClient(config);
        const { projectRoot } = config;

        if (options.provider && !getProvider(options.provider)) {
          fail(`Unknown provider "${options.provider}".`, `Use one of: ${PROVIDER_NAMES.join(", ")}.`);
        }

        const project = await pickProject(client, config.projectId, projectRoot);
        const scheme =
          options.scheme ?? project.deepLinkScheme ?? expoScheme(projectRoot) ?? project.slug ?? undefined;

        const projectConfig: ProjectConfig = {
          projectId: project.id,
          apiUrl: config.apiUrl as string,
          channel: options.channel,
          appKey: project.appKey,
          deepLinkScheme: scheme,
          publicKey: project.publicKey,
          runtimeVersion: { policy: "fingerprint" },
        };
        const configPath = saveProjectConfig(projectRoot, projectConfig);
        ok(`Wrote ${configPath}`);
        note("Commit it — the public key in there is what the app uses to verify updates.");

        await wireApp(projectRoot, {
          projectId: project.id,
          apiUrl: projectConfig.apiUrl,
          channel: projectConfig.channel,
          scheme,
          publicKey: project.publicKey,
          appKey: project.appKey,
        });

        if (options.provider) {
          const provider = getProvider(options.provider);
          if (provider) {
            await runProvision(
              provider,
              {
                projectRoot,
                projectId: project.id,
                apiUrl: projectConfig.apiUrl,
                bucket: "ota-bundles",
                masterKey: generateMasterKey(),
              },
              { dryRun: options.dryRun, yes: options.yes },
            );
          }
        }

        print("");
        print(bold("Next:"));
        print(`  ota fingerprint      ${dim("# stamp the native compatibility hash and commit it")}`);
        print(`  ota doctor           ${dim("# confirm the wiring took")}`);
        print(`  ota publish -c ${projectConfig.channel}`);
      },
    );
}

async function pickProject(
  client: OtaClient,
  projectId: string | undefined,
  projectRoot: string,
): Promise<Project> {
  if (projectId) return (await client.getProject(projectId)).project;

  const { projects } = await client.listProjects();
  const choice = await ask<"projectId">({
    type: "select",
    name: "projectId",
    message: "Project",
    choices: [
      ...projects.map((project) => ({ title: `${project.name} (${project.id})`, value: project.id })),
      { title: "Create a new project…", value: "" },
    ],
  });

  if (choice.projectId) {
    const found = projects.find((project) => project.id === choice.projectId);
    return found ?? (await client.getProject(choice.projectId as string)).project;
  }

  const answers = await ask<"name" | "scheme">([
    {
      type: "text",
      name: "name",
      message: "Project name",
      initial: readPackageJson(projectRoot)?.name ?? "my-app",
    },
    {
      type: "text",
      name: "scheme",
      message: "Deep link scheme (for preview QR codes)",
      initial: expoScheme(projectRoot) ?? "",
    },
  ]);

  step("Creating the project and its RSA signing key…");
  const { project } = await client.createProject({
    name: answers.name as string,
    deepLinkScheme: (answers.scheme as string) || undefined,
  });
  return project;
}

async function wireApp(
  projectRoot: string,
  options: PluginOptions & { publicKey?: string; appKey?: string },
): Promise<void> {
  if (hasExpoUpdates(projectRoot)) {
    warn("This project also uses expo-updates. Two owners of the JS bundle will fight — remove it first.");
  }

  const kind = detectAppKind(projectRoot);
  const pluginOptions: PluginOptions = {
    projectId: options.projectId,
    apiUrl: options.apiUrl,
    channel: options.channel,
    ...(options.scheme ? { scheme: options.scheme } : {}),
  };

  if (kind === "expo") {
    const result = wireExpoPlugin(projectRoot, pluginOptions);
    if (result.kind === "written") ok(`Added the ${PLUGIN_PACKAGE} plugin to ${result.path}`);
    if (result.kind === "unchanged") note(`${result.path} already has the plugin entry.`);
    if (result.kind === "manual") {
      warn(`Add this to the "plugins" array in ${result.path}:`);
      print(`  ${result.snippet.split("\n").join("\n  ")}`);
    }
    note("Run `npx expo prebuild` (or a new dev build) so the native boot path is injected.");
    return;
  }

  if (kind === "bare") {
    const codemods = await loadCodemods(projectRoot);
    if (!codemods) {
      warn(`${PLUGIN_PACKAGE} is not installed here, so the native files were not patched.`);
      note(`Install it and re-run \`ota init\`: npm install ${PLUGIN_PACKAGE}`);
      return;
    }
    const codemodConfig = {
      projectId: options.projectId,
      apiUrl: options.apiUrl,
      appKey: options.appKey,
      channel: options.channel,
      scheme: options.scheme,
      publicKey: options.publicKey,
    };
    const checks = [
      ...codemods.applyAndroid(projectRoot, codemodConfig),
      ...codemods.applyIos(projectRoot, codemodConfig),
    ];
    for (const check of checks) {
      if (check.status === "applied") continue;
      if (check.status === "notApplicable") continue;
      warn(`${check.id}: ${check.status}${check.reason ? ` — ${check.reason}` : ""}`);
    }
    if (checks.every((c) => c.status === "applied" || c.status === "notApplicable")) {
      ok("Patched the native boot path (MainApplication / AppDelegate) and the deep link scheme.");
    } else {
      note("Fix the items above and re-run `ota init`; `ota doctor` re-checks them.");
    }
    return;
  }

  warn("Could not tell whether this is an Expo or a bare React Native project — nothing was wired.");
  note("Run `ota init` from the app directory, or apply the setup from the README by hand.");
}
