/**
 * MCP tool contract — schemas and metadata only, no transport and no client.
 *
 * This lives in the shared package because both transports must expose exactly
 * the same tools: the `/mcp` route on the server and `ota mcp` over stdio. An
 * agent that connects one way must not see a different surface than one that
 * connects the other.
 *
 * Nothing here may import a transport or a runtime — each side binds its own
 * handlers to these shapes. ARCHITECTURE §3.5.
 */

import { z } from "zod";

import { PLATFORMS, RELEASE_STATUSES } from "./protocol.js";

const projectId = z.string().min(1).describe("Project id. Defaults to the one in ota.config.json.");const channel = z.string().min(1).describe("Channel name, e.g. production or staging.");
const platform = z.enum(PLATFORMS).describe("Target platform.");
const rolloutPercent = z
  .number()
  .int()
  .min(0)
  .max(100)
  .describe("Share of devices offered the release. Raising it only ever adds devices.");

/**
 * Release-targeting tools take a reference, not just an id: people say "v53",
 * not a uuid. Labels repeat across platforms and channels, so those narrow it.
 */
const releaseRef = {
  projectId: projectId.optional(),
  release: z.string().min(1).describe('Release id, or a label such as "v42".'),
  platform: platform.optional().describe("Required when the same label exists on both platforms."),
  channel: channel.optional().describe("Narrows a label lookup to one channel."),
};

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
    ...releaseRef,
  },
  get_release_metrics: {
    ...releaseRef,
    days: z.number().int().min(1).max(90).optional().describe("Days of daily series to include."),
  },
  get_version_distribution: {
    projectId: projectId.optional(),
    platform: platform.optional(),
    windowDays: z.number().int().min(1).max(90).optional().describe("Activity window, default 30 days."),
  },
  get_rollback_rate: {
    projectId: projectId.optional(),
    channel: channel.optional().describe("Restrict to one channel."),
    platform: platform.optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe("How many recent releases to compare, newest first. Default 5."),
    days: z.number().int().min(1).max(90).optional().describe("Window for the counters. Default 14."),
  },
  publish_release: {
    projectId: projectId.optional(),
    releaseId: z
      .string()
      .optional()
      .describe("Confirm a release already uploaded by `ota publish`. The only form a remote server accepts."),
    bundleDir: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Directory holding an already-built export. Only works over stdio, where the tool runs on the machine holding the files — a remote server cannot read your disk.",
      ),
    platform: platform.optional(),
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
    // `channel` narrows which release a label refers to; `toChannel` is where
    // it lands. Two different meanings, so two different names.
    ...releaseRef,
    toChannel: channel.describe("Destination channel — the release is copied into it."),
    rolloutPercent: rolloutPercent.optional().describe("Rollout in the destination channel. Default 100."),
  },
  pause_release: {
    ...releaseRef,
  },
  resume_release: {
    ...releaseRef,
  },
  rollback_release: {
    ...releaseRef,
  },
  set_rollout_percentage: {
    ...releaseRef,
    rolloutPercent,
  },
  generate_release_deeplink: {
    ...releaseRef,
    ttlMinutes: z.number().int().min(1).max(1440).optional().describe("Link lifetime, default 15 minutes."),
  },
  generate_release_qrcode: {
    ...releaseRef,
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
      "Publish a release. Over stdio, pass bundleDir pointing at an `expo export` output and it is zipped, uploaded and confirmed locally. Over HTTP, pass releaseId to confirm an upload `ota publish` already made — a remote server has no access to your files. Never runs a build.",
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
