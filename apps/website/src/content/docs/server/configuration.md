---
title: Configuration
description: Every environment variable the server reads, what it does, and which mode or driver needs it.
---

`apps/server/src/config.ts` is the source of truth. It parses the environment
with a schema at boot and throws with the list of problems if anything is
missing or malformed, so a misconfigured server fails to start rather than
failing on the first request.

Two variables are always required: `DATABASE_URL` and `OTA_MASTER_KEY`.

## Core

| Variable | Default | What it does |
|---|---|---|
| `OTA_MODE` | `self` | `self` is one organisation, no billing, no metering, signup closed after the first account. `hosted` turns on multi-tenancy, signup, quotas and Stripe. See [hosted mode](/server/hosted-mode/). |
| `PORT` | `3000` | Listen port. Node entry only; Workers and Deno ignore it. Also used to build the default `PUBLIC_URL`. |
| `DATABASE_URL` | — | Postgres connection string. Required. On Cloudflare it is not set: the Worker reads `env.HYPERDRIVE.connectionString` instead. |
| `OTA_MASTER_KEY` | — | 32 random bytes, base64. Required. Seals project private signing keys. |
| `PUBLIC_URL` | `http://localhost:${PORT}` | Public base URL of this server. Trailing slashes are stripped. Required in `hosted` mode — OAuth metadata and checkout redirects are built from it. |
| `CORS_ORIGINS` | `*` | Origins allowed to call `/api/*`. |
| `DASHBOARD_DIR` | unset | Directory of the built dashboard SPA. Set to `/app/dashboard` by the Docker image. Node entry only; when unset, no static files are served. |
| `OTA_ADMIN_EMAIL`, `OTA_ADMIN_PASSWORD` | unset | First-boot only, `self` mode only, and only while the `users` table is empty: creates the admin account and its organisation. The password needs 10 characters or more. Read directly by `src/entry/node.ts`, not by the config schema. |

## Storage

| Variable | Default | What it does |
|---|---|---|
| `STORAGE_DRIVER` | `s3` | `s3` (R2, S3, MinIO), `supabase`, or `local`. |
| `STORAGE_ENDPOINT` | unset | S3 endpoint. `s3` driver. Falls back to `https://s3.${STORAGE_REGION}.amazonaws.com` when unset. |
| `STORAGE_REGION` | `auto` | S3 region. `auto` for R2; a real region for AWS. |
| `STORAGE_BUCKET` | `ota-bundles` | Bucket name. `s3` and `supabase` drivers. |
| `STORAGE_ACCESS_KEY` | unset | S3 access key id. Without both keys the S3 client is built without credentials. |
| `STORAGE_SECRET_KEY` | unset | S3 secret. |
| `STORAGE_FORCE_PATH_STYLE` | `false` | Path-style addressing. `true` for MinIO, `false` for S3 and R2. |
| `STORAGE_LOCAL_DIR` | `.ota/bundles` | Directory on disk. `local` driver only. |
| `PUBLIC_BUNDLE_BASE_URL` | unset | CDN origin in front of the bucket. All drivers. |
| `SUPABASE_URL` | unset | Project URL. Required by the `supabase` driver, which throws at boot without it. |
| `SUPABASE_SERVICE_ROLE_KEY` | unset | Service role key. Also required by the `supabase` driver. |

The `local` driver cannot sign URLs, so uploads and downloads route through
`/api/v1/storage/...` on the server itself. It is meant for development and
tests, and it is the one driver where the server always re-verifies the
uploaded digest before activating a release.

## Email

| Variable | Default | What it does |
|---|---|---|
| `EMAIL_DRIVER` | `console` | `console`, `resend` or `smtp`. |
| `EMAIL_FROM` | `Open OTA <noreply@localhost>` | From address on outbound mail. |
| `RESEND_API_KEY` | unset | Required for real delivery; without it the `resend` driver falls back to the log. |

Mail is only sent for hosted email verification, so a self-hosted install can
leave this alone and read the link out of the server log.

:::caution
`smtp` is accepted by the schema but not implemented. `createEmailSender` has
one real branch — Resend — and everything else prints the message to the server
log. Use `resend`, or read the log.
:::

## Billing

| Variable | Default | What it does |
|---|---|---|
| `STRIPE_SECRET_KEY` | unset | Turns billing on, but only in `hosted` mode: `billingEnabled` is `hosted && STRIPE_SECRET_KEY`. Without it every billing route answers 400. |
| `STRIPE_WEBHOOK_SECRET` | unset | Verifies the signature on `POST /api/v1/billing/webhook`. Without it the webhook is refused. |
| `STRIPE_PORTAL_RETURN_URL` | `${PUBLIC_URL}/billing` | Where the Stripe customer portal sends people back to. |

## Hosted

`hosted` mode adds no variables of its own beyond making `PUBLIC_URL`
mandatory. What it changes is behaviour: organisations, open signup with email
verification, plan quotas, and the Stripe routes above. In `self` mode all of
that is off and the plan limits are effectively unlimited. See
[hosted mode](/server/hosted-mode/).

## PUBLIC_BUNDLE_BASE_URL

The address devices download bundles from, which is not necessarily the address
the server uploads to. When it is set, the URL handed to a device is
`${PUBLIC_BUNDLE_BASE_URL}/${key}`; when it is not, the server derives one from
the storage endpoint, and that address has to be reachable from the phone.

Bundles are immutable — new content is always a new release with a new key — so
whatever sits at this origin can cache forever
(`cache-control: public, max-age=31536000, immutable`). The bundle URL is
deliberately outside the signed manifest, so changing this value does not
invalidate a single existing release.

## CORS_ORIGINS

A comma-separated list, or `*`. It applies to `/api/*` and allows the
`authorization`, `content-type`, `x-ota-app-key` and `x-ota-sdk-version`
headers. `*` is fine while the server is on a private network. Narrow it once
the server is exposed — the dashboard origin, plus `http://localhost:4321` if
you use `ota console`, which runs the SPA locally against a remote API.

## OTA_MASTER_KEY

Generate it once:

```bash
openssl rand -base64 32
```

Every project gets its own RSA-2048 key pair when it is created. The public
half is written into `ota.config.json` and compiled into your app; the private
half is stored encrypted with AES-256-GCM under this key, and only ever
decrypted in memory to sign a manifest or a preview token. The value must
decode to exactly 32 bytes or the server refuses to use it.

Losing it means every project's private key is unrecoverable: you re-key each
project, and every installed binary carries a public key that no longer matches,
so they all need a new release through the store. Keep it in a secret manager,
and keep a copy somewhere other than the host running the server.
