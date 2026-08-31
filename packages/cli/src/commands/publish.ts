import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { dim } from "kleur/colors";
import { PLATFORMS, uuidv7, type Platform, type Release } from "@open-ota/shared";

import { createClient } from "../client.js";
import { requireApi, requireProjectId, resolveConfig } from "../config.js";
import { exec, gitCommit } from "../exec.js";
import { requireRuntimeVersion } from "../fingerprint.js";
import { fail, formatBytes, note, ok, parsePercent, printJson, printTable, step } from "../output.js";
import { bundleDirFor, publishArchive } from "../publish.js";
import { zipDirectory, type BundleArchive } from "../zip.js";

interface PublishFlags {
  channel?: string;
  platform: string;
  rollout?: number;
  mandatory?: boolean;
  message?: string;
  bundleDir?: string;
  project?: string;
  dryRun?: boolean;
  json?: boolean;
}

export function registerPublish(program: Command): void {
  program
    .command("publish")
    .description("export, zip, upload and release a JS bundle")
    .option("-c, --channel <name>", "channel to publish to")
    .option("-p, --platform <platform>", "ios | android | all", "all")
    .option("--rollout <percent>", "percentage of devices offered the update", parsePercent)
    .option("--mandatory", "apply on the next launch instead of waiting")
    .option("-m, --message <text>", "release note")
    .option("--bundle-dir <dir>", "publish a prebuilt export instead of running expo export")
    .option("--project <id>", "override the configured project id")
    .option("--dry-run", "build and hash the bundles without publishing")
    .option("--json", "print the published releases as JSON")
    .action(async (flags: PublishFlags) => {
      const config = resolveConfig({ projectId: flags.project, channel: flags.channel });
      const projectId = requireProjectId(config);
      const { apiUrl, token } = requireApi(config);
      const client = createClient(config);
      const runtimeVersion = requireRuntimeVersion(config.projectRoot);
      const platforms = resolvePlatforms(flags.platform);

      // One publish, one group: iOS and Android from the same JS are a single
      // logical release for the dashboard and for rollout control.
      const groupId = uuidv7();
      const commit = gitCommit(config.projectRoot);
      const built: Array<{ platform: Platform; archive: BundleArchive; release?: Release }> = [];
      const temporaryDirs: string[] = [];

      try {
        for (const platform of platforms) {
          const bundleDir = flags.bundleDir
            ? bundleDirFor(flags.bundleDir, platform)
            : await expoExport(config.projectRoot, platform, temporaryDirs);

          step(`Zipping ${platform} bundle from ${bundleDir}`);
          const archive = await zipDirectory(bundleDir);
          note(`  ${archive.entryCount} files · ${formatBytes(archive.bytes.length)} · ${archive.sha256.slice(0, 12)}`);

          if (flags.dryRun) {
            built.push({ platform, archive });
            continue;
          }

          step(`Publishing ${platform} to ${config.channel}`);
          const release = await publishArchive({
            client,
            projectId,
            platform,
            channel: config.channel,
            runtimeVersion,
            archive,
            rolloutPercent: flags.rollout,
            mandatory: flags.mandatory,
            message: flags.message,
            gitCommit: commit,
            groupId,
            apiUrl,
            token,
          });
          built.push({ platform, archive, release });
        }
      } finally {
        await Promise.all(temporaryDirs.map((dir) => rm(dir, { recursive: true, force: true })));
      }

      if (flags.json) {
        printJson({
          dryRun: Boolean(flags.dryRun),
          groupId,
          runtimeVersion,
          releases: built.map((entry) => ({
            platform: entry.platform,
            sha256: entry.archive.sha256,
            size: entry.archive.bytes.length,
            release: entry.release ?? null,
          })),
        });
        return;
      }

      printTable(
        [
          { header: "LABEL" },
          { header: "RELEASE" },
          { header: "PLATFORM" },
          { header: "SIZE", align: "right" },
          { header: "SHA256" },
          { header: "CHANNEL" },
          { header: "ROLLOUT", align: "right" },
        ],
        built.map((entry) => [
          entry.release ? `v${entry.release.label}` : "—",
          entry.release?.id ?? "—",
          entry.platform,
          formatBytes(entry.archive.bytes.length),
          entry.archive.sha256.slice(0, 12),
          entry.release?.channel ?? config.channel,
          entry.release ? `${entry.release.rolloutPercent}%` : "—",
        ]),
      );

      if (flags.dryRun) note("\nDry run — nothing was uploaded.");
      else {
        ok(`\nPublished to ${config.channel} · runtime ${runtimeVersion} · group ${groupId}`);
        note(dim("Devices pick it up on their next update-check."));
      }
    });
}

function resolvePlatforms(value: string): Platform[] {
  if (value === "all") return [...PLATFORMS];
  if ((PLATFORMS as readonly string[]).includes(value)) return [value as Platform];
  fail(`Unknown platform "${value}".`, "Use ios, android or all.");
}

async function expoExport(projectRoot: string, platform: Platform, cleanup: string[]): Promise<string> {
  const outputDir = await mkdtemp(join(tmpdir(), `ota-export-${platform}-`));
  cleanup.push(outputDir);

  const local = join(projectRoot, "node_modules", ".bin", "expo");
  const [command, prefix] = existsSync(local) ? [local, []] : ["npx", ["expo"]];

  step(`expo export (${platform})`);
  await exec(command, [...prefix, "export", "--platform", platform, "--output-dir", outputDir, "--clear"], {
    cwd: projectRoot,
  });
  return outputDir;
}
