---
title: Self-host with Docker
description: Run the server, Postgres and MinIO with docker compose, and swap the bucket for R2 or S3 when you are ready.
---

`docker-compose.yml` at the repository root brings up three services and one
init job. Copy the environment file, fill three values, and start it.

```bash
cp .env.example .env
docker compose up -d
```

## The services

- **server** — built from the `Dockerfile` in the repo root and tagged
  `openota/server:latest`. Node 22 on Alpine, running a single esbuild bundle at
  `dist/entry/node.js`. Published on `${PORT:-3000}:3000`.
- **postgres** — `postgres:17`, database `ota`, user `ota`, volume
  `ota-postgres`. The server waits on its `pg_isready` healthcheck.
- **minio** — object storage on `:9000`, console on `:9001`, volume
  `ota-minio`. Credentials are `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY`.
- **minio-init** — a one-shot `minio/mc` container that creates the bucket and
  makes it world-readable, because devices download bundles with no
  credentials. It retries `mc alias set` in a loop instead of waiting on a
  healthcheck, since the MinIO image ships no tool to probe itself with. The
  server will not start until this job completes successfully.

## The three values you must set

Compose refuses to start without them.

```bash
openssl rand -base64 32     # OTA_MASTER_KEY
```

| Variable | What it is |
|---|---|
| `OTA_MASTER_KEY` | 32 random bytes, base64. Seals every project's RSA private signing key at rest with AES-256-GCM. |
| `POSTGRES_PASSWORD` | Password for the `ota` database user; also builds `DATABASE_URL`. |
| `STORAGE_SECRET_KEY` | MinIO root password, and the S3 secret the server signs upload URLs with. |

Losing `OTA_MASTER_KEY` means re-keying every project and shipping new binaries,
because the public half of each key pair is compiled into your app. Keep a copy
somewhere other than the host running the server.

## What happens on boot

The Node entry (`apps/server/src/entry/node.ts`) is the only target that boots
the install by itself:

1. Applies pending migrations from `drizzle/`.
2. Seeds the three plans (free, pro, scale).
3. On an empty `users` table in `OTA_MODE=self`, creates the first admin
   account and its organisation from `OTA_ADMIN_EMAIL` / `OTA_ADMIN_PASSWORD`.
   The password needs 10 characters or more. If the account cannot be created
   the server logs the reason and keeps serving.
4. Serves the built dashboard from `DASHBOARD_DIR` (`/app/dashboard` in the
   image), falling back to `index.html` for any GET that is not under `/api`,
   `/oauth`, `/mcp`, `/healthz` or `/.well-known`.

Leave `OTA_ADMIN_EMAIL` empty and the first account is instead created by
signing up in the dashboard. In `self` mode signup closes permanently after
that first account.

`GET /healthz` reports mode, storage driver and whether billing is on.

## The MinIO address

:::caution
An S3 presigned URL is signed for a specific host, so the CLI and the devices
must reach the bucket at the SAME address the server signs it with. `minio`
works only for server-side calls — set `STORAGE_ENDPOINT` to your machine's LAN
address (`http://192.168.1.10:9000`) as soon as you publish from the CLI or
download onto a device.
:::

This is the one string that has to be right. The default in `.env.example` is
`http://minio:9000`, which resolves only inside the compose network.
`STORAGE_FORCE_PATH_STYLE=true` is required for MinIO and wrong for S3 and R2.

## Swapping MinIO for R2 or S3

Delete the `minio` and `minio-init` services, then point the storage variables
at the real bucket:

```bash
STORAGE_DRIVER=s3
STORAGE_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
STORAGE_REGION=auto
STORAGE_BUCKET=ota-bundles
STORAGE_ACCESS_KEY=<api-token-id>
STORAGE_SECRET_KEY=<api-token-secret>
STORAGE_FORCE_PATH_STYLE=false
```

The bucket has to allow anonymous reads on the `bundles/` prefix, or sit behind
a CDN that does.

## Putting a CDN in front

Set `PUBLIC_BUNDLE_BASE_URL` to the CDN hostname. It is used only to build the
download URL handed to devices; uploads still go to `STORAGE_ENDPOINT`.

```bash
PUBLIC_BUNDLE_BASE_URL=https://cdn.example.com
```

A release is immutable — new content is always a new release with a new id and
a new key — so the objects can be cached forever. Configure the CDN with
`cache-control: public, max-age=31536000, immutable`. The bundle URL sits
outside the signed manifest precisely so you can change this later without
invalidating any existing release.

## Backups

`pg_dump` plus the bucket. Bundles are immutable, so they never need
versioning. Upgrading is `docker compose pull` followed by a restart:
migrations run again on boot.

:::caution
The Docker image has not been built and run end to end yet. The Node path was
smoke-tested against a real Postgres; the `Dockerfile` itself is
configuration-level. See [known limitations](/reference/limitations/).
:::
