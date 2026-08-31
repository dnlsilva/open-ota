# Open OTA

Self-hosted over-the-air updates for React Native and Expo. Ship JavaScript and asset changes without an App Store or Play Store review, and actually see what happens next: who received the update, who installed it, who came back up, and who rolled back.

CodePush was retired in March 2025. EAS Update is hosted, paid and closed. [hot-updater](https://github.com/gronxb/hot-updater) is the best self-hosted option today but solves only the update *mechanism*. Open OTA keeps that mechanism, adds the operational half CodePush had — adoption metrics, gradual rollout, promotion between channels, remote rollback — and signs every release.

```bash
ota publish --channel production --rollout 10
```

```
v42  android  production   rollout 10%   4.8 MB   b94d27b9…
     8,250 devices · 82.5% of base · 99.6% ready · 0.4% rollback
```

## What it does

- **Signed releases.** Every manifest is signed with a per-project RSA key; the device verifies the signature and the bundle digest before a single byte executes. A compromised CDN cannot inject code.
- **Automatic rollback.** If a release crashes before the app reports it started cleanly, the device reverts on the next launch, tells the server, and is never offered that release again.
- **Gradual rollout.** Deterministic, stateless bucketing by device and release. Raising a percentage only ever adds devices.
- **Adoption you can read.** Active devices per OTA release and per native app version, funnel and rollback rate per release, adoption over time — without storing one row per event.
- **Native compatibility, structurally.** A release is pinned to the fingerprint of the native project it was built against, and to a floor id stamped into the binary, so an update can never reach an incompatible build.
- **Open a specific release on a real device.** The dashboard generates a signed deep link as a QR code; scan it and that exact release installs, pinned, without touching the global rollout.
- **Run it anywhere.** Supabase, Cloudflare or plain Docker — one codebase, one Postgres schema.
- **Drive it from an agent.** A remote MCP endpoint means Claude, Cursor or Codex connect with one command and can publish, roll out and read metrics in natural language.

## Quick start

```bash
docker compose up -d              # server + postgres + minio
npx @open-ota/cli login
npx @open-ota/cli init            # links the project and wires the native side
npx @open-ota/cli publish -c staging --rollout 10
```

In the app:

```tsx
import { OpenOta, OtaProvider } from "@open-ota/react-native";

export default OpenOta.wrap(function App() {
  return <OtaProvider>{/* your app */}</OtaProvider>;
});
```

That is the whole integration. The config plugin (Expo) or `ota init` (bare React Native) handles the native wiring, the deep link scheme and the embedded public key.

## Repository

```
apps/server         Hono: Device API + Admin API + MCP endpoint. Runs on Node, Deno and Workers
apps/dashboard      React SPA — releases, rollout control, adoption, device distribution
packages/react-native  SDK (Expo Modules API, Kotlin + Swift) + config plugin + bare RN codemods
packages/cli        `ota` — publish, promote, rollout, rollback, metrics, preview, doctor, mcp
packages/shared     the contract: protocol types, canonical JSON, signing, rollout bucketing, API client
examples/expo-demo  end-to-end harness
```

## How it works

The server answers one question — *which release should this device be running* — and the SDK converges on the answer. That single mechanism covers updates, downgrades when a release is disabled, and a return to the bundle inside the binary. The bundle URL is deliberately outside the signed manifest: it is transport, free to move between CDNs, while integrity comes from the digest and authenticity from the signature.

Telemetry costs O(devices) + O(releases × days), never O(events). The update check is already the heartbeat, so measuring active users per version needs no extra request; each installation is one row written at most hourly, and the funnel lives in daily counters. At 100k devices that is a handful of writes per second.

## Deployment

| Target | Runtime | Database | Storage |
|---|---|---|---|
| Supabase | Edge Function | Supabase Postgres | Supabase Storage |
| Cloudflare | Workers | Postgres via Hyperdrive | R2 |
| Docker | Node | Postgres | MinIO / S3 / R2 |

`ota init --provider supabase` provisions the whole thing in one command. Set `OTA_MODE=hosted` to run it multi-tenant with signup, plans and Stripe; the default `self` mode is a single organisation with no billing and no metering.

See [apps/server/README.md](apps/server/README.md) for the per-target details.

## Documentation

| Doc | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How hot-updater, Expo Updates and CodePush each solve this, the architecture, stack decisions with trade-offs, and the publish/update/rollback/preview flows |
| [docs/API.md](docs/API.md) | The SDK↔server protocol, the admin endpoints, the security and signing model |
| [docs/DATA-MODEL.md](docs/DATA-MODEL.md) | Schema, entity mapping, and the cheap-telemetry strategy |
| [docs/BUILD-PLAN.md](docs/BUILD-PLAN.md) | Scope, build order, risks and the validation matrix |

Design documents are in Portuguese; code, comments and this README are in English.

## Status

Early. The server, SDK, CLI, dashboard and MCP endpoint are implemented, with 177 tests across the workspace — including an end-to-end suite that runs the real migrations against a real Postgres engine in-process, so no Docker is needed to check the spine of the product.

What has **not** happened yet is the part only hardware can settle: the native boot path and offline asset resolution on physical iOS and Android devices, across both the old and new React Native architectures. Nothing here has run on a phone. Treat it as pre-release until that matrix is green.

```bash
pnpm install && pnpm typecheck && pnpm test
```

## License

MIT
