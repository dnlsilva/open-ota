---
title: Tool reference
description: The fifteen MCP tools, their arguments and what each one returns.
---

Declared once in `packages/shared/src/mcp.ts` and bound by both transports. See
[connect an agent](/mcp/connect/) for how to reach them.

Two conventions run through the table.

**`projectId` is optional everywhere.** Over stdio it defaults to the project in
`ota.config.json`. Over HTTP there is no such file, so either pass it —
`list_projects` gives you one — or use a token scoped to a single project,
which supplies it.

**A release reference is not just an id.** Tools that target a release take
`release`, which accepts a uuid or a label such as `v42`, plus optional
`platform` and `channel`. Labels are per channel and platform, so `platform` is
required when the same label exists on both, and `channel` narrows the lookup.
Those tools are marked *ref* below.

| Tool | Arguments | Returns | Read-only |
|---|---|---|---|
| `list_projects` | `orgId?` | Projects this token can administer | yes |
| `get_project` | `projectId?` | App key, public key, deep link scheme, channels | yes |
| `list_releases` | `projectId?`, `channel?`, `platform?`, `status?` (`pending`/`active`/`paused`/`disabled`), `limit?` (1–200, default 20) | Releases newest first | yes |
| `get_release` | *ref* | Label, status, rollout, runtime version, size, hash | yes |
| `get_release_metrics` | *ref*, `days?` (1–90, default 14) | Funnel — downloads, installs, ready, failed, rollbacks, success and rollback rates, active devices — plus a daily series | yes |
| `get_version_distribution` | `projectId?`, `platform?`, `windowDays?` (1–90, default 30) | Devices per OTA release, including the embedded bundle, and the native version split, each with a percentage of base | yes |
| `get_rollback_rate` | `projectId?`, `channel?`, `platform?`, `limit?` (1–20, default 5), `days?` (1–90, default 14) | Recent releases newest first, each with installs, rollbacks and rollback rate, ready to compare | yes |
| `publish_release` | `projectId?`, `releaseId?`, `bundleDir?`, `platform?`, `channel?`, `runtimeVersion?`, `rolloutPercent?`, `mandatory?`, `message?`, `groupId?` | The published release | no |
| `promote_release` | *ref*, `toChannel`, `rolloutPercent?` (default 100) | The new release in the destination channel | no |
| `pause_release` | *ref* | The release, now `paused` | no |
| `resume_release` | *ref* | The release, now `active` | no |
| `rollback_release` | *ref* | The disabled release and the release devices will converge to, or `null` for the embedded bundle | no |
| `set_rollout_percentage` | *ref*, `rolloutPercent` (0–100) | The release at its new percentage | no |
| `generate_release_deeplink` | *ref*, `ttlMinutes?` (1–1440, default 15) | Signed deep link, its expiry and the scheme | no |
| `generate_release_qrcode` | *ref*, `ttlMinutes?` (1–1440, default 15) | The same link, rendered | no |

Read-only is advertised to clients as an MCP `readOnlyHint`. The two link tools
are not marked read-only because they mint a signed credential and require an
`admin` scope, even though they change no release state.

`generate_release_qrcode` renders differently per transport: over stdio the CLI
returns an ASCII QR code plus the URL, and over HTTP the server returns the URL
as text plus a 512px PNG image block, falling back to text alone if the encoder
is unavailable. The URL always rides along, so a client that cannot display an
image still gets something actionable.

`runtimeVersion` on `publish_release` defaults to the value in the project's
`fingerprint.json`. `groupId` links the iOS and Android releases built from the
same JavaScript.

## The four prompts

| What you say | What it calls |
|---|---|
| "Publish the current build to staging." | `publish_release` |
| "What percentage is still on v41?" | `get_version_distribution` |
| "Is v52 rolling back more than the one before it?" | `get_rollback_rate` |
| "Roll v53 out to 10%." | `set_rollout_percentage` |

The third one returns both releases in a single call — recent releases newest
first, each with its rate — so the comparison is one request, not two.

## publish_release and the transport split

This tool never runs a build. What it accepts depends on which transport you
are connected over, and that is deliberate.

**Over stdio**, pass `bundleDir` pointing at an `expo export` output, along with
`platform`. The tool runs on the machine holding the files: it zips the
directory, hashes it, uploads it and confirms the release, exactly as
`ota publish` would.

**Over HTTP**, the only accepted form is `releaseId` — confirming an upload the
CLI already made. Pass `bundleDir` to a remote server and you get an error
telling you why. There is no filesystem branch in the server implementation at
all.

The reason is direct. A remote server has no access to your disk, so the
argument could not work; and if it did read a caller-supplied path, any admin
token could make the server open a local file and hand back its contents as a
published bundle. That is a file-read primitive, not a feature. Building and
uploading is the CLI's job; the tool only confirms the result. See the
[security model](/reference/security/).

So the agent workflow over HTTP is two steps: run `ota publish`, then ask the
agent to confirm and roll out the release id it printed. Over stdio it is one.
