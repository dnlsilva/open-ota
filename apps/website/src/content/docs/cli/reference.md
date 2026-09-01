---
title: Command reference
description: Every ota command with its real flags, plus config resolution and exit codes.
---

Install it, or run it as `npx @open-ota/cli <command>`. Human output goes to
stderr and machine-readable output to stdout, so `--json` is safe to pipe.

## login

`ota login --url https://ota.example.com` stores the API url and a token in
`~/.config/open-ota/config.json`, written `0600`. It prompts for a token or an
email and password, and checks it against the server before saving.

`--url <url>` · `--token <token>` — both skip their prompt.

## init

`ota init --provider docker -c staging` creates or links a project, writes
`ota.config.json`, and wires the app: the config plugin entry in `app.json` for
Expo, or native codemods for a bare project.

`--provider <supabase|cloudflare|docker>` (prints or runs backend provisioning) ·
`--project <id>` · `-c, --channel <name>` (default `production`) ·
`--scheme <scheme>` (deep link scheme) · `--dry-run` · `-y, --yes`

## fingerprint

`ota fingerprint --check` compares the committed `fingerprint.json` against the
project and fails on drift, which is what CI wants. Without `--check` it writes
the file. Commit it: it is the contract between a bundle and the binaries
allowed to run it.

`--check` · `--json`

## publish

```bash
ota publish -c production --rollout 10 -m "Payment retry flow"
```

Runs `expo export` per platform, zips the output as-is, uploads it straight to
storage and confirms the release. iOS and Android from one run are linked by a
group id.

`-c, --channel <name>` · `-p, --platform <ios|android|all>` (default `all`) ·
`--rollout <percent>` · `--mandatory` (apply on the next launch) ·
`-m, --message <text>` · `--bundle-dir <dir>` (publish a prebuilt export) ·
`--project <id>` · `--dry-run` (build and hash only) · `--json`

## releases, release

`ota releases -c production --status active` lists releases newest first.
`ota release v42 --platform android` shows one, by id or label. Labels are per
channel and platform, so pass `--platform` when one exists on both.

`releases`: `-c, --channel <name>` · `-p, --platform <platform>` ·
`--status <pending|active|paused|disabled>` · `--limit <n>` (default 20) ·
`--project <id>` · `--json`. `release <labelOrId>` takes the same flags without
`--status` and `--limit`.

## promote, rollout

`ota promote v42 production --rollout 25` copies a release into another channel
as a new release with its own id and label, reusing the same bundle. `ota
rollout v42 50` changes the percentage; lowering it warns that it stops new
devices only, because devices already on the release keep it.

`promote <release> <channel>`: `--rollout <percent>` · `-c, --channel <name>`
(channel to resolve the label against) · `--project <id>`

`rollout <release> <percent>`: `-c, --channel <name>` · `--project <id>`

## pause, resume, disable, rollback

`ota pause v43` stops offering a release to new devices while installed ones
keep it, and `ota resume v43` offers it again. `ota disable v43` pulls it, so
devices converge to the previous release or the embedded bundle. `ota rollback
-c production` does that to the newest active release on a channel, per
platform, and reports where devices will land. Both confirm first.

`pause|resume|disable <release>`: `-c, --channel <name>` · `--project <id>` ·
`-y, --yes`

`rollback`: `-c, --channel <name>` · `--release <id>` (roll back this one
instead) · `--project <id>` · `-y, --yes`

## metrics

`ota metrics -c production --window 7` prints the adoption funnel for the
channel's current releases, then the version distribution by OTA release and by
native version. With `--release` it prints one release plus its daily series.

`-c, --channel <name>` · `--release <id>` · `--window <days>` (default 30) ·
`--project <id>` · `--json`

## preview

`ota preview v42 --ttl 60` prints a QR code that opens exactly that release on a
device with the app installed and a matching fingerprint. The preview stays
pinned until `exitPreview()`.

`--ttl <minutes>` (default 15) · `-c, --channel <name>` · `--project <id>` ·
`--json`

## doctor

`ota doctor` checks `ota.config.json`, the public key, credentials, API
reachability, token validity, whether the project resolves, native wiring,
fingerprint drift and a conflicting `expo-updates` install. Exits 1 on failure.

`--project <id>` · `--json`

## console

`ota console --port 4321` serves the dashboard locally against your API — the
story for the edge targets, where nothing hosts static files for you.

`--port <port>` (default 4321) · `--dist <dir>`

## mcp

`ota mcp` runs the MCP server over stdio. See [connect an agent](/mcp/connect/).

`--project <id>` (default project for tools that omit one) · `-c, --channel
<name>` (default channel for `publish_release`)

## Configuration

Highest precedence first: flags, then environment, then `ota.config.json` in the
project (committed), then `~/.config/open-ota/config.json` (machine-local, holds
the token). The environment variables are `OTA_API_URL`, `OTA_TOKEN`,
`OTA_PROJECT_ID` and `OTA_CHANNEL`. The token is only ever read from the
environment or the machine file, never from the committed project file. The
project root is the nearest ancestor directory containing `ota.config.json`,
otherwise the nearest containing `package.json`.

## Exit codes

`0` ok, `1` failure, `2` usage error.
