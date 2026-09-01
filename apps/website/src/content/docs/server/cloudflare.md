---
title: Deploy to Cloudflare
description: Run the server as a Worker with Postgres over Hyperdrive and bundles in R2.
---

The Worker entry is `apps/server/src/entry/worker.ts`. Bindings only exist
inside `fetch`, so the application context is built per request; Hyperdrive
keeps the real connection pool warm at the edge, which is what makes a fresh
Postgres client per request affordable. Each request opens a pool of one and
closes it in `ctx.waitUntil`.

| Runtime | Database | Storage |
|---|---|---|
| Workers | Postgres via Hyperdrive | R2 through the S3 API |

## Bindings

`apps/server/wrangler.toml`:

```toml
name = "open-ota"
main = "src/entry/worker.ts"
compatibility_date = "2025-01-01"
# postgres-js and the AWS SDK both need the Node built-ins.
compatibility_flags = ["nodejs_compat"]

[[hyperdrive]]
binding = "HYPERDRIVE"
id = "<hyperdrive-id>"

[[r2_buckets]]
binding = "BUNDLES"
bucket_name = "ota-bundles"

[vars]
OTA_MODE = "self"
STORAGE_DRIVER = "s3"
STORAGE_BUCKET = "ota-bundles"
STORAGE_REGION = "auto"
```

`DATABASE_URL` is not a variable on this target: the Worker reads
`env.HYPERDRIVE.connectionString` and passes it to the config loader itself.

Secrets go in with `wrangler secret put`, never in the file: `OTA_MASTER_KEY`,
`STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, plus `RESEND_API_KEY` and the
Stripe keys if you use them.

## Why R2 goes through the S3 adapter

The `BUNDLES` binding attaches the bucket to the Worker, but a bucket binding
cannot mint a signed upload URL. The CLI needs one: it uploads the zip straight
to the bucket so the bundle never crosses the API. Only R2's S3-compatible
endpoint can issue that signed `PUT`, so the server uses the existing S3
adapter and needs an R2 API token even though the bucket is also bound.

```bash
STORAGE_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
PUBLIC_BUNDLE_BASE_URL=https://<public-r2-or-cdn-hostname>
```

`STORAGE_FORCE_PATH_STYLE` stays `false` for R2.

## What `ota init --provider cloudflare` runs

`packages/cli/src/providers/cloudflare.ts` is a flat list of five steps, each
printed before it runs and confirmed when it changes remote state. Without
`wrangler` on `PATH`, or with `--dry-run`, the list is printed and nothing
executes.

| Step | Command |
|---|---|
| Create the D1 database | `wrangler d1 create open-ota` |
| Create the R2 bucket | `wrangler r2 bucket create ota-bundles` |
| Apply the migrations | `wrangler d1 migrations apply open-ota --remote` |
| Store the master key | `wrangler secret put OTA_MASTER_KEY` (wrangler reads the value from stdin; the CLI prints the generated key to paste) |
| Deploy the Worker | `wrangler deploy` |

:::caution
The first and third steps are stale. They provision D1, which the design moved
away from: the Worker entry and `wrangler.toml` expect Postgres over
Hyperdrive, and there is one SQL dialect across all three targets. Use the
manual sequence below and treat the provider as a reminder of the shape.
:::

## Doing it by hand

```bash
wrangler hyperdrive create open-ota --connection-string="postgres://..."   # id -> wrangler.toml
wrangler r2 bucket create ota-bundles
wrangler secret put OTA_MASTER_KEY
wrangler secret put STORAGE_ACCESS_KEY     # R2 API token id
wrangler secret put STORAGE_SECRET_KEY     # R2 API token secret
DATABASE_URL=postgres://... pnpm --filter @open-ota/server db:migrate
wrangler deploy
```

Migrations do not run on this target. Point `DATABASE_URL` at the same database
Hyperdrive fronts and run them before the first deploy, and again after every
upgrade.

## The dashboard

The Worker does not serve static files. Run the dashboard locally against the
deployed API with `ota console`, or deploy `apps/dashboard/dist` to Pages.

## What is verified

`src/app.ts` is the same object on all three targets and is covered by the
server test suite, including the real migrations run against a real Postgres
engine in-process. Signing is Web Crypto only, so it runs unchanged on Workers.

:::caution
This target has not been deployed end to end. The Worker entry, `wrangler.toml`
and the provider steps are typecheck- and configuration-level only — see
[known limitations](/reference/limitations/).
:::
