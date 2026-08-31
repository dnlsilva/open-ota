import type { Command } from "commander";
import { bold } from "kleur/colors";
import type { OtaClient, ReleaseMetrics } from "@open-ota/shared";

import { createClient } from "../client.js";
import { requireProjectId, resolveConfig } from "../config.js";
import { formatPercent, print, printJson, printTable, warn } from "../output.js";

/**
 * `percentOfBase` arrives as a percentage (0-100) while `successRate` and
 * `rollbackRate` are ratios (0-1) — they are defined as ready/installs in
 * types.ts. Formatting differs accordingly.
 */
export function funnelRows(metrics: ReleaseMetrics[], platformOf: (id: string) => string): string[][] {
  return metrics.map((entry) => [
    `v${entry.label}`,
    platformOf(entry.releaseId),
    String(entry.activeDevices),
    String(entry.downloads),
    String(entry.installs),
    String(entry.ready),
    String(entry.failed),
    String(entry.rollbacks),
    formatPercent(entry.successRate),
    formatPercent(entry.rollbackRate),
  ]);
}

const FUNNEL_COLUMNS = [
  { header: "RELEASE", align: "right" as const },
  { header: "PLATFORM" },
  { header: "DEVICES", align: "right" as const },
  { header: "DOWNLOADS", align: "right" as const },
  { header: "INSTALLS", align: "right" as const },
  { header: "READY", align: "right" as const },
  { header: "FAILED", align: "right" as const },
  { header: "ROLLBACKS", align: "right" as const },
  { header: "SUCCESS", align: "right" as const },
  { header: "ROLLBACK", align: "right" as const },
];

export function registerMetrics(program: Command): void {
  program
    .command("metrics")
    .description("adoption funnel and version distribution")
    .option("-c, --channel <name>", "channel to report on")
    .option("--release <id>", "report on a single release")
    .option("--window <days>", "distribution window in days", (value) => Number(value), 30)
    .option("--project <id>", "override the configured project id")
    .option("--json", "print as JSON")
    .action(
      async (flags: {
        channel?: string;
        release?: string;
        window: number;
        project?: string;
        json?: boolean;
      }) => {
        const config = resolveConfig({ projectId: flags.project, channel: flags.channel });
        const projectId = requireProjectId(config);
        const client = createClient(config);

        if (flags.release) {
          const [metrics, { release }] = await Promise.all([
            client.getReleaseMetrics(flags.release),
            client.getRelease(flags.release),
          ]);
          if (flags.json) return printJson({ metrics, release });

          print(bold(`v${metrics.label} · ${release.platform} · ${release.channel}`));
          printTable(FUNNEL_COLUMNS, funnelRows([metrics], () => release.platform));
          printDaily(metrics);
          return;
        }

        const [overview, distribution] = await Promise.all([
          client.getOverview(projectId),
          client.getDistribution(projectId, { windowDays: flags.window }),
        ]);

        const channels = overview.channels.filter((entry) => entry.channel === config.channel);
        const current = channels.map((entry) => entry.currentRelease).filter((release) => release !== null);
        const metrics = await fetchMetrics(client, current.map((release) => release.id));

        if (flags.json) {
          return printJson({ channel: config.channel, channels, metrics, distribution });
        }

        print(bold(`${config.channel} · ${distribution.totalDevices} devices seen in ${flags.window}d`));
        if (metrics.length === 0) warn("No active release on this channel yet.");
        else {
          const platformOf = (id: string) =>
            current.find((release) => release.id === id)?.platform ?? "—";
          printTable(FUNNEL_COLUMNS, funnelRows(metrics, platformOf));
        }

        print("");
        print(bold("Version distribution"));
        printTable(
          [
            { header: "RELEASE", align: "right" },
            { header: "PLATFORM" },
            { header: "DEVICES", align: "right" },
            { header: "% OF BASE", align: "right" },
            { header: "INSTALLS", align: "right" },
            { header: "ROLLBACKS", align: "right" },
          ],
          distribution.releases.map((row) => [
            row.label === null ? "embedded" : `v${row.label}`,
            row.platform,
            String(row.devices),
            `${row.percentOfBase.toFixed(1)}%`,
            String(row.installs),
            String(row.rollbacks),
          ]),
        );

        if (distribution.nativeVersions.length > 0) {
          print("");
          print(bold("Native versions"));
          printTable(
            [
              { header: "VERSION" },
              { header: "PLATFORM" },
              { header: "DEVICES", align: "right" },
              { header: "% OF BASE", align: "right" },
            ],
            distribution.nativeVersions.map((row) => [
              row.nativeVersion,
              row.platform,
              String(row.devices),
              `${row.percentOfBase.toFixed(1)}%`,
            ]),
          );
        }
      },
    );
}

function fetchMetrics(client: OtaClient, releaseIds: string[]): Promise<ReleaseMetrics[]> {
  return Promise.all(releaseIds.map((id) => client.getReleaseMetrics(id)));
}

function printDaily(metrics: ReleaseMetrics): void {
  if (metrics.daily.length === 0) return;
  print("");
  print(bold("Daily"));
  printTable(
    [
      { header: "DAY" },
      { header: "DOWNLOADS", align: "right" },
      { header: "INSTALLS", align: "right" },
      { header: "READY", align: "right" },
      { header: "FAILED", align: "right" },
      { header: "ROLLBACKS", align: "right" },
    ],
    metrics.daily.map((day) => [
      day.day,
      String(day.downloads),
      String(day.installs),
      String(day.ready),
      String(day.failed),
      String(day.rollbacks),
    ]),
  );
}
