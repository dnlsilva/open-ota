import type { Command } from "commander";
import { bold, dim } from "kleur/colors";
import {
  PLATFORMS,
  RELEASE_STATUSES,
  type OtaClient,
  type Platform,
  type Release,
  type ReleaseStatus,
} from "@open-ota/shared";

import { createClient } from "../client.js";
import { requireProjectId, resolveConfig, type ResolvedConfig } from "../config.js";
import { fail, formatBytes, ok, parsePercent, print, printJson, printTable, warn } from "../output.js";
import { confirm } from "../prompt.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerReleases(program: Command): void {
  program
    .command("releases")
    .description("list releases")
    .option("-c, --channel <name>", "filter by channel")
    .option("-p, --platform <platform>", "ios | android")
    .option("--status <status>", RELEASE_STATUSES.join(" | "))
    .option("--limit <n>", "how many to show", (value) => Number(value), 20)
    .option("--project <id>", "override the configured project id")
    .option("--json", "print as JSON")
    .action(
      async (flags: {
        channel?: string;
        platform?: string;
        status?: string;
        limit: number;
        project?: string;
        json?: boolean;
      }) => {
        const config = resolveConfig({ projectId: flags.project });
        const client = createClient(config);
        const { releases } = await client.listReleases(requireProjectId(config), {
          channel: flags.channel,
          platform: assertPlatform(flags.platform),
          status: assertStatus(flags.status),
          limit: flags.limit,
        });

        if (flags.json) return printJson({ releases });
        if (releases.length === 0) return warn("No releases match.");

        printTable(
          [
            { header: "LABEL", align: "right" },
            { header: "PLATFORM" },
            { header: "CHANNEL" },
            { header: "STATUS" },
            { header: "ROLLOUT", align: "right" },
            { header: "SIZE", align: "right" },
            { header: "CREATED" },
            { header: "ID" },
          ],
          releases.map((release) => [
            `v${release.label}`,
            release.platform,
            release.channel,
            release.mandatory ? `${release.status} (mandatory)` : release.status,
            `${release.rolloutPercent}%`,
            formatBytes(release.size),
            release.createdAt.slice(0, 16).replace("T", " "),
            release.id.slice(0, 8),
          ]),
        );
      },
    );

  program
    .command("release")
    .argument("<labelOrId>", "release id, or a channel label like v42")
    .description("show one release")
    .option("-c, --channel <name>", "channel to resolve a label against")
    .option("-p, --platform <platform>", "platform to resolve a label against")
    .option("--project <id>", "override the configured project id")
    .option("--json", "print as JSON")
    .action(
      async (
        labelOrId: string,
        flags: { channel?: string; platform?: string; project?: string; json?: boolean },
      ) => {
        const config = resolveConfig({ projectId: flags.project, channel: flags.channel });
        const client = createClient(config);
        const release = await resolveRelease(client, config, labelOrId, flags.platform);

        if (flags.json) return printJson({ release });

        print(bold(`v${release.label} · ${release.platform} · ${release.channel}`));
        printTable(
          [{ header: "FIELD" }, { header: "VALUE" }],
          [
            ["id", release.id],
            ["status", release.status],
            ["rollout", `${release.rolloutPercent}%`],
            ["mandatory", String(release.mandatory)],
            ["runtime", release.runtimeVersion],
            ["size", formatBytes(release.size)],
            ["sha256", release.sha256],
            ["group", release.groupId ?? "—"],
            ["commit", release.gitCommit?.slice(0, 12) ?? "—"],
            ["message", release.message ?? "—"],
            ["created", release.createdAt],
          ],
        );
      },
    );

  program
    .command("promote")
    .argument("<release>", "release id or label")
    .argument("<channel>", "destination channel")
    .description("copy a release into another channel")
    .option("--rollout <percent>", "rollout in the destination channel", parsePercent)
    .option("-c, --channel <name>", "channel to resolve a label against")
    .option("--project <id>", "override the configured project id")
    .action(
      async (
        target: string,
        channel: string,
        flags: { rollout?: number; channel?: string; project?: string },
      ) => {
        const config = resolveConfig({ projectId: flags.project, channel: flags.channel });
        const client = createClient(config);
        const source = await resolveRelease(client, config, target);
        const { release } = await client.promoteRelease(source.id, channel, flags.rollout);
        ok(
          `Promoted v${source.label} (${source.platform}) to ${channel} as v${release.label} at ${release.rolloutPercent}%.`,
        );
      },
    );

  program
    .command("rollout")
    .argument("<release>", "release id or label")
    .argument("<percent>", "0-100", parsePercent)
    .description("set the rollout percentage")
    .option("-c, --channel <name>", "channel to resolve a label against")
    .option("--project <id>", "override the configured project id")
    .action(async (target: string, percent: number, flags: { channel?: string; project?: string }) => {
      const config = resolveConfig({ projectId: flags.project, channel: flags.channel });
      const client = createClient(config);
      const current = await resolveRelease(client, config, target);

      // Lowering never removes a device that already installed — only disabling
      // does. Say so rather than let the number imply a recall.
      if (percent < current.rolloutPercent) {
        warn(
          `Lowering ${current.rolloutPercent}% → ${percent}% stops new devices only; devices already on v${current.label} keep it.`,
        );
      }

      const { release } = await client.updateRelease(current.id, { rolloutPercent: percent });
      ok(`v${release.label} (${release.platform}) is now at ${release.rolloutPercent}%.`);
    });

  for (const [name, status, description] of [
    ["pause", "paused", "stop offering to new devices; installed devices keep it"],
    ["resume", "active", "offer the release again"],
    ["disable", "disabled", "pull the release — devices converge away from it"],
  ] as const) {
    program
      .command(name)
      .argument("<release>", "release id or label")
      .description(description)
      .option("-c, --channel <name>", "channel to resolve a label against")
      .option("--project <id>", "override the configured project id")
      .option("-y, --yes", "skip the confirmation")
      .action(async (target: string, flags: { channel?: string; project?: string; yes?: boolean }) => {
        const config = resolveConfig({ projectId: flags.project, channel: flags.channel });
        const client = createClient(config);
        const current = await resolveRelease(client, config, target);

        if (name === "disable" && !flags.yes) {
          const proceed = await confirm(
            `Disable v${current.label} (${current.platform}, ${current.channel})? Devices on it will move to the previous release or the embedded bundle.`,
          );
          if (!proceed) return warn("Cancelled.");
        }

        const { release } = await client.updateRelease(current.id, { status });
        ok(`v${release.label} (${release.platform}) is now ${release.status}.`);
      });
  }

  program
    .command("rollback")
    .description("disable the newest active release on a channel")
    .option("-c, --channel <name>", "channel to roll back")
    .option("--release <id>", "roll back this release instead")
    .option("--project <id>", "override the configured project id")
    .option("-y, --yes", "skip the confirmation")
    .action(async (flags: { channel?: string; release?: string; project?: string; yes?: boolean }) => {
      const config = resolveConfig({ projectId: flags.project, channel: flags.channel });
      const client = createClient(config);
      const projectId = requireProjectId(config);

      const targets = flags.release
        ? [(await client.getRelease(flags.release)).release]
        : newestActivePerPlatform(
            (await client.listReleases(projectId, { channel: config.channel, status: "active" })).releases,
          );

      if (targets.length === 0) {
        fail(`No active release on ${config.channel}.`, "Nothing to roll back.");
      }

      if (!flags.yes) {
        const summary = targets.map((release) => `v${release.label} (${release.platform})`).join(", ");
        if (!(await confirm(`Roll back ${summary} on ${config.channel}?`))) return warn("Cancelled.");
      }

      for (const target of targets) {
        const { release, target: next } = await client.rollbackRelease(target.id);
        ok(
          `v${release.label} (${release.platform}) disabled — devices converge to ${
            next ? `v${next.label}` : "the embedded bundle"
          }.`,
        );
      }
      print(dim("Rollback shows up in the metrics within minutes as devices check in."));
    });
}

function newestActivePerPlatform(releases: Release[]): Release[] {
  const newest = new Map<Platform, Release>();
  for (const release of releases) {
    const current = newest.get(release.platform);
    if (!current || release.label > current.label) newest.set(release.platform, release);
  }
  return [...newest.values()];
}

/** Accepts a uuid, `v42` or `42`; labels are per channel+platform. */
export async function resolveRelease(
  client: OtaClient,
  config: ResolvedConfig,
  labelOrId: string,
  platform?: string,
): Promise<Release> {
  if (UUID.test(labelOrId)) return (await client.getRelease(labelOrId)).release;

  const label = Number(labelOrId.replace(/^v/i, ""));
  if (!Number.isInteger(label)) {
    fail(`"${labelOrId}" is neither a release id nor a label like v42.`);
  }

  const { releases } = await client.listReleases(requireProjectId(config), {
    channel: config.channel,
    platform: assertPlatform(platform),
    limit: 200,
  });
  const matches = releases.filter((release) => release.label === label);

  if (matches.length === 0) {
    fail(`No release labelled v${label} on channel ${config.channel}.`, "Try `ota releases` to list them.");
  }
  if (matches.length > 1) {
    fail(
      `v${label} exists for ${matches.map((release) => release.platform).join(" and ")} on ${config.channel}.`,
      "Pass --platform, or use the release id.",
    );
  }
  return matches[0] as Release;
}

export function assertPlatform(value: string | undefined): Platform | undefined {
  if (!value) return undefined;
  if (!(PLATFORMS as readonly string[]).includes(value)) fail(`Unknown platform "${value}".`, "Use ios or android.");
  return value as Platform;
}

function assertStatus(value: string | undefined): ReleaseStatus | undefined {
  if (!value) return undefined;
  if (!(RELEASE_STATUSES as readonly string[]).includes(value)) {
    fail(`Unknown status "${value}".`, `Use one of: ${RELEASE_STATUSES.join(", ")}.`);
  }
  return value as ReleaseStatus;
}
