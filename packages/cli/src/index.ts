import { createRequire } from "node:module";
import { Command, CommanderError } from "commander";

import { registerConsole } from "./commands/console.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerFingerprint } from "./commands/fingerprint.js";
import { registerInit } from "./commands/init.js";
import { registerLogin } from "./commands/login.js";
import { registerMcp } from "./commands/mcp.js";
import { registerMetrics } from "./commands/metrics.js";
import { registerPreview } from "./commands/preview.js";
import { registerPublish } from "./commands/publish.js";
import { registerReleases } from "./commands/releases.js";
import { EXIT_USAGE, reportError } from "./output.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

export function buildProgram(): Command {
  // Set before the subcommands exist: commander copies it into each of them.
  const program = new Command().exitOverride();

  program
    .name("ota")
    .description("Open OTA — publish, promote, roll out and roll back React Native updates")
    .version(version)
    .addHelpText(
      "after",
      `
Configuration resolves in this order: flags, environment, ota.config.json, ~/.config/open-ota/config.json.
Environment: OTA_API_URL, OTA_TOKEN, OTA_PROJECT_ID, OTA_CHANNEL.
Exit codes: 0 ok, 1 failure, 2 usage error.`,
    );

  registerLogin(program);
  registerInit(program);
  registerFingerprint(program);
  registerPublish(program);
  registerReleases(program);
  registerMetrics(program);
  registerPreview(program);
  registerDoctor(program);
  registerConsole(program);
  registerMcp(program);

  return program;
}

export async function run(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      // Commander already printed help or the usage error itself.
      process.exitCode = error.exitCode === 0 ? 0 : EXIT_USAGE;
      return;
    }
    process.exitCode = reportError(error);
  }
}

await run();
