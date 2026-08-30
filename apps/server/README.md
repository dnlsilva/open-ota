# @open-ota/server

One Hono app, three runtimes. `src/app.ts` is identical everywhere; only the
entry around it changes.

| Target | Entry | Database | Storage |
|---|---|---|---|
| Docker / Node | `src/entry/node.ts` | Postgres | MinIO, S3 or R2 |
| Supabase Edge | `src/entry/deno.ts` | Supabase Postgres | Supabase Storage |
| Cloudflare Workers | `src/entry/worker.ts` | Postgres via Hyperdrive | R2 (S3 API) |

Every variable is documented in [`.env.example`](../../.env.example) at the repo
root. Two are always required: `DATABASE_URL` and `OTA_MASTER_KEY`
(`openssl rand -base64 32` — it seals each project's private signing key, and
losing it means re-keying every project and shipping new binaries).

## Docker / Node

```bash
cp .env.example .env      # fill OTA_MASTER_KEY, POSTGRES_PASSWORD, STORAGE_SECRET_KEY
docker compose up -d
```

The Node entry is the only one that boots the install by itself: it applies
pending migrations, seeds the plans, and — on an empty users table in
`OTA_MODE=self` — creates the first admin from `OTA_ADMIN_EMAIL` /
`OTA_ADMIN_PASSWORD`. It also serves the built dashboard from `DASHBOARD_DIR`,
falling back to `index.html` for anything that is not `/api`, `/oauth`, `/mcp`,
`/healthz` or `/.well-known`.

What matters here: `DATABASE_URL`, `OTA_MASTER_KEY`, `STORAGE_*`,
`OTA_ADMIN_EMAIL` / `OTA_ADMIN_PASSWORD`, `DASHBOARD_DIR`, `PORT`.

Without Docker:

```bash
pnpm db:migrate
pnpm dev                  # tsx watch
pnpm build && pnpm start  # single esbuild bundle at dist/entry/node.js
```

`STORAGE_ENDPOINT` is the one address that has to be right: an S3 presigned URL
is signed for a specific host, so the server, the CLI and the devices must all
reach the bucket at the same string. `minio` works only inside the compose
network — use your LAN address as soon as anything outside it publishes or
downloads.

## Supabase

```bash
supabase link --project-ref <ref>
supabase db push                                   # migrations in ./drizzle
supabase secrets set OTA_MASTER_KEY=... OTA_MODE=self STORAGE_BUCKET=ota-bundles
supabase functions deploy ota --no-verify-jwt      # our own Bearer auth, not Supabase JWTs
```

The Supabase CLI bundles the function with Deno's own resolver, so point it at
this entry — `supabase/functions/ota/index.ts`:

```ts
import "../../../apps/server/src/entry/deno.ts";
```

Deno resolves specifiers literally and this codebase writes `.js` for `.ts`
files, so the function needs a `deno.json` next to it with
`{ "unstable": ["sloppy-imports"] }`.

What matters here: `STORAGE_DRIVER=supabase`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `OTA_MASTER_KEY`, `DATABASE_URL`. Migrations do not
run on boot — `supabase db push` owns the schema.

## Cloudflare Workers

Bindings and vars live in [`wrangler.toml`](./wrangler.toml).

```bash
wrangler hyperdrive create open-ota --connection-string="postgres://..."   # id -> wrangler.toml
wrangler r2 bucket create ota-bundles
wrangler secret put OTA_MASTER_KEY
wrangler secret put STORAGE_ACCESS_KEY     # R2 API token
wrangler secret put STORAGE_SECRET_KEY
DATABASE_URL=postgres://... pnpm db:migrate
wrangler deploy
```

R2 is used through the S3 adapter, not the bucket binding: only the S3 endpoint
can mint the signed upload URLs the CLI needs. Point `STORAGE_ENDPOINT` at
`https://<account-id>.r2.cloudflarestorage.com` and `PUBLIC_BUNDLE_BASE_URL` at
the bucket's public hostname.

The dashboard is not served by the Worker. Run it locally with `ota console`, or
deploy `apps/dashboard/dist` to Pages.

## Pointing the SDK at it

The URL is baked into the binary by the config plugin, so it comes from
`app.json` (Expo) or the codemods (bare RN):

```json
["@open-ota/react-native", {
  "projectId": "…", "apiUrl": "https://ota.example.com", "channel": "production", "scheme": "myapp"
}]
```

`ota init` writes that entry and `ota.config.json` for you. A device never gets
a secret: it sends the project's public app key and verifies every manifest
against the public key embedded at build time.

`GET /healthz` reports mode, storage driver and whether billing is on.
