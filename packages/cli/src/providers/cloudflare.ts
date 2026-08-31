import type { Provider } from "./index.js";

/** Workers + D1 + R2 (ARCHITECTURE §7). */
export const cloudflareProvider: Provider = {
  name: "cloudflare",
  requires: ["wrangler"],
  steps: (context) => [
    {
      title: "Create the D1 database",
      command: ["wrangler", "d1", "create", "open-ota"],
      destructive: true,
      note: "Copy the printed database_id into wrangler.toml under [[d1_databases]].",
    },
    {
      title: "Create the R2 bucket",
      command: ["wrangler", "r2", "bucket", "create", context.bucket],
      destructive: true,
    },
    {
      title: "Apply the migrations",
      command: ["wrangler", "d1", "migrations", "apply", "open-ota", "--remote"],
      destructive: true,
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
