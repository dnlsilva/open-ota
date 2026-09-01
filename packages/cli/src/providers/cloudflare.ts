import type { Provider } from "./index.js";

/**
 * Workers + Postgres over Hyperdrive + R2 (ARCHITECTURE §7).
 *
 * The Worker speaks the same single Postgres dialect as every other target, so
 * it needs a real Postgres reachable from Cloudflare (Supabase, Neon, RDS, a
 * box of your own) fronted by Hyperdrive — there is no D1 schema to apply.
 */
export const cloudflareProvider: Provider = {
  name: "cloudflare",
  requires: ["wrangler"],
  steps: (context) => [
    {
      title: "Create the R2 bucket",
      command: ["wrangler", "r2", "bucket", "create", context.bucket],
      destructive: true,
    },
    {
      title: "Create the Hyperdrive config pointing at your Postgres",
      command: [
        "wrangler",
        "hyperdrive",
        "create",
        "open-ota",
        "--connection-string",
        "<postgres://user:password@host:5432/ota>",
      ],
      note: "Copy the printed id into wrangler.toml under [[hyperdrive]]. The database itself lives wherever you run Postgres — Hyperdrive is the pooled path to it.",
    },
    {
      title: "Apply the migrations to that Postgres",
      command: ["pnpm", "--filter", "@open-ota/server", "db:migrate"],
      note: "Run with DATABASE_URL set to the same connection string. Migrations run over a direct connection, not through the Worker.",
    },
    {
      title: "Store the master key",
      command: ["wrangler", "secret", "put", "OTA_MASTER_KEY"],
      note: `wrangler reads the value from stdin. Paste: ${context.masterKey}`,
    },
    {
      title: "Deploy the Worker",
      command: ["wrangler", "deploy"],
      destructive: true,
    },
  ],
};
