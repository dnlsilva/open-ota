/**
 * MCP tool contract — schemas and metadata only, no transport and no client.
 *
 * ARCHITECTURE §3.5 wants one definition behind two transports (stdio here,
 * Streamable HTTP in the server), so nothing in this module may import a
 * transport or a runtime: the server package imports these same shapes and
 * binds its own handlers.
 */

import { z } from "zod";

import { PLATFORMS, RELEASE_STATUSES } from "@open-ota/shared";

const projectId = z.string().min(1).describe("Project id. Defaults to the one in ota.config.json.");
const releaseId = z.string().min(1).describe("Release id (uuid).");
const channel = z.string().min(1).describe("Channel name, e.g. production or staging.");
const platform = z.enum(PLATFORMS).describe("Target platform.");
const rolloutPercent = z
  .number()
  .int()
  .min(0)
  .max(100)
  .describe("Share of devices offered the release. Raising it only ever adds devices.");

export const otaToolShapes = {
  list_projects: {
    orgId: z.string().optional().describe("Restrict to one organisation."),
  },
  get_project: {
    projectId: projectId.optional(),
  },
  list_releases: {
    projectId: projectId.optional(),
    channel: channel.optional(),
    platform: platform.optional(),
    status: z.enum(RELEASE_STATUSES).optional().describe("Filter by release status."),
    limit: z.number().int().min(1).max(200).optional(),
  },
  get_release: {
    releaseId,
  },
  get_release_metrics: {
    releaseId,
    days: z.number().int().min(1).max(90).optional().describe("Days of daily series to include."),
  },
  get_version_distribution: {
    projectId: projectId.optional(),
    platform: platform.optional(),
    windowDays: z.number().int().min(1).max(90).optional().describe("Activity window, default 30 days."),
  },
  get_rollback_rate: {
    projectId: projectId.optional(),
    releaseId: z.string().optional().describe("Compare this release against the previous one on its channel."),
    channel: channel.optional().describe("Report the channel's current releases instead."),
  },
  publish_release: {
    projectId: projectId.optional(),
    bundleDir: z
      .string()
      .min(1)
      .describe("Directory holding an already-built export (run `expo export` or `ota publish` first)."),
    platform,
    channel: channel.optional(),
    runtimeVersion: z
      .string()
      .optional()
      .describe("Defaults to the runtimeVersion in the project's fingerprint.json."),
    rolloutPercent: rolloutPercent.optional(),
    mandatory: z.boolean().optional().describe("Apply on the next launch instead of waiting."),
    message: z.string().max(500).optional(),
    groupId: z.string().optional().describe("Link iOS and Android releases from the same build."),
  },
  promote_release: {
    releaseId,
    channel: channel.describe("Destination channel."),
    rolloutPercent: rolloutPercent.optional(),
  },
  pause_release: {
    releaseId,
  },
  resume_release: {
    releaseId,
  },
  rollback_release: {
    releaseId,
  },
  set_rollout_percentage: {
    releaseId,
    rolloutPercent,
  },
  generate_release_deeplink: {
    releaseId,
    ttlMinutes: z.number().int().min(1).max(1440).optional().describe("Link lifetime, default 15 minutes."),
  },
  generate_release_qrcode: {
    releaseId,
    ttlMinutes: z.number().int().min(1).max(1440).optional().describe("Link lifetime, default 15 minutes."),
  },
} satisfies Record<string, z.ZodRawShape>;

export type OtaToolName = keyof typeof otaToolShapes;
export type OtaToolInput<N extends OtaToolName> = z.infer<z.ZodObject<(typeof otaToolShapes)[N]>>;

export interface OtaToolDefinition {
  name: OtaToolName;
  title: string;
  description: string;
  inputShape: z.ZodRawShape;
  /** Advertised as an MCP readOnlyHint. */
  readOnly: boolean;
}

const META: Record<OtaToolName, { title: string; description: string; readOnly: boolean }> = {
  list_projects: {
    title: "List projects",
    description: "List the OTA projects this token can administer.",
    readOnly: true,
  },
  get_project: {
    title: "Get project",
    description: "Project details: app key, public key, deep link scheme, channels.",
    readOnly: true,
  },
  list_releases: {
    title: "List releases",
    description: "Releases newest first, filterable by channel, platform and status.",
    readOnly: true,
  },
  get_release: {
    title: "Get release",
    description: "One release: label, status, rollout, runtime version, size and hash.",
    readOnly: true,
  },
  get_release_metrics: {
    title: "Release metrics",
    description:
      "Adoption funnel for a release — downloads, installs, ready, failed, rollbacks, plus a daily series.",
    readOnly: true,
  },
  get_version_distribution: {
    title: "Version distribution",
    description:
      "Which release each device is running, and the native version split. Answers 'what percentage is still on v41?'.",
    readOnly: true,
  },
  get_rollback_rate: {
    title: "Rollback rate",
    description:
      "Rollback rate for a release compared with the previous one on the same channel, or for a channel's current releases.",
    readOnly: true,
  },
  publish_release: {
    title: "Publish release",
    description:
      "Publish an already-built bundle directory: zip, upload to storage, confirm. Does not run any build — point it at the output of `expo export`.",
    readOnly: false,
  },
  promote_release: {
    title: "Promote release",
    description: "Copy a release into another channel, optionally at a lower rollout.",
    readOnly: false,
  },
  pause_release: {
    title: "Pause release",
    description: "Stop offering a release to new devices. Devices already on it keep it.",
    readOnly: false,
  },
  resume_release: {
    title: "Resume release",
    description: "Offer a paused release again.",
    readOnly: false,
  },
  rollback_release: {
    title: "Roll back release",
    description:
      "Disable a release so devices converge to the previous one, or to the bundle embedded in the binary.",
    readOnly: false,
  },
  set_rollout_percentage: {
    title: "Set rollout percentage",
    description:
      "Change the share of devices offered a release. Lowering it stops new devices only; it does not uninstall.",
    readOnly: false,
  },
  generate_release_deeplink: {
    title: "Release deep link",
    description: "Signed, short-lived deep link that opens a release on a device with the app installed.",
    readOnly: false,
  },
  generate_release_qrcode: {
    title: "Release QR code",
    description:
      "QR code for a release preview link, returned as ASCII art plus the raw url (no PNG: the CLI has no image encoder among its dependencies).",
    readOnly: false,
  },
};

export const otaTools: readonly OtaToolDefinition[] = (Object.keys(otaToolShapes) as OtaToolName[]).map(
  (name) => ({ name, inputShape: otaToolShapes[name], ...META[name] }),
);

export const otaToolByName: Record<OtaToolName, OtaToolDefinition> = Object.fromEntries(
  otaTools.map((tool) => [tool.name, tool]),
) as Record<OtaToolName, OtaToolDefinition>;

export function toolSchema<N extends OtaToolName>(name: N): z.ZodObject<(typeof otaToolShapes)[N]> {
  return z.object(otaToolShapes[name]);
}

/** Validates tool arguments, turning zod's report into one readable line. */
export function parseToolInput<N extends OtaToolName>(name: N, args: unknown): OtaToolInput<N> {
  const result = toolSchema(name).safeParse(args ?? {});
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid arguments for ${name} — ${problems}`);
  }
  return result.data as OtaToolInput<N>;
}
