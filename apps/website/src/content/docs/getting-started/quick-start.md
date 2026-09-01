---
title: Quick start
description: From nothing to a published, signed release on a device — server, CLI and SDK.
---

Four moving parts: a server you run, a CLI that publishes, an SDK inside the app, and a dashboard to watch it land. This page walks the shortest path through all four.

## 1. Start a server

```bash
git clone https://github.com/dnlsilva/open-ota && cd open-ota
cp .env.example .env
openssl rand -base64 32   # → paste as OTA_MASTER_KEY in .env
docker compose up -d      # server + postgres + minio
```

The server runs its migrations on boot and creates the first admin account from `OTA_ADMIN_EMAIL` / `OTA_ADMIN_PASSWORD` if you set them — otherwise the first signup on a self-hosted install becomes the admin. The dashboard is served on the same port: [http://localhost:3000](http://localhost:3000).

:::caution
The compose defaults point storage at `http://minio:9000`, a hostname that only resolves *inside* the compose network. The moment you publish from your terminal or download onto a phone, set `STORAGE_ENDPOINT` and `PUBLIC_BUNDLE_BASE_URL` to an address those machines can reach — your LAN IP while developing. Presigned URLs are signed for one hostname, so this is not optional. Details in [Self-host with Docker](/server/docker/).
:::

Prefer Supabase or Cloudflare over Docker? Same server, different entry point — see [deploy targets](/server/docker/).

## 2. Create a project and wire the app

```bash
npx @open-ota/cli login    # email + password from step 1
npx @open-ota/cli init
```

`init` creates (or links) a project, writes `ota.config.json` with the project id, API URL and the project's public signing key, and wires the native side:

- **Expo**: adds the `@open-ota/react-native` config plugin to `app.json`. The plugin injects the boot path, the embedded config and the deep link scheme at prebuild.
- **Bare React Native**: applies the same edits directly to your native files, idempotently.

Then wrap the app:

```tsx
import { OpenOta, OtaProvider } from "@open-ota/react-native";

export default OpenOta.wrap(function App() {
  return <OtaProvider>{/* your app */}</OtaProvider>;
});
```

`OtaProvider` checks for an update on launch and confirms a healthy start after the first frame — the confirmation that arms the [automatic rollback](/guides/rollback/).

Build and install a dev build (`npx expo run:android` / `run:ios`). Expo Go cannot load a native module, so it will not work here.

## 3. Publish

```bash
npx @open-ota/cli publish --channel staging --rollout 10
```

The CLI exports your JavaScript, zips it deterministically, hashes it, uploads straight to storage and asks the server to sign and activate the release:

```
LABEL  RELEASE                               PLATFORM  SIZE    SHA256        CHANNEL  ROLLOUT
v1     0193a4c8-…                            android   4.8 MB  b94d27b9934d  staging  10%
v1     0193a4c9-…                            ios       4.9 MB  1d5a90d3c2aa  staging  10%
```

## 4. Watch it land

Relaunch the app twice — once to download, once to run the new bundle. Then:

- **Dashboard** → your project → the release: downloads, installs, ready, rollback rate.
- **Terminal**: `npx @open-ota/cli metrics --channel staging`

When staging looks healthy:

```bash
npx @open-ota/cli promote v1 production --rollout 25
```

From here: [gradual rollout](/guides/rollout/), [rollback](/guides/rollback/), [preview a release by QR code](/guides/preview/), or [connect an agent over MCP](/mcp/connect/).
