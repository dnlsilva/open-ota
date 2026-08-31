import type { Provider } from "./index.js";

/** Supabase Edge Function + Postgres + Storage (ARCHITECTURE §7). */
export const supabaseProvider: Provider = {
  name: "supabase",
  requires: ["supabase"],
  steps: (context) => [
    {
      title: "Link this directory to your Supabase project",
      command: ["supabase", "link", "--project-ref", "<project-ref>"],
      note: "The ref is in the project url: https://supabase.com/dashboard/project/<project-ref>.",
    },
    {
      title: "Push the schema",
      command: ["supabase", "db", "push"],
      destructive: true,
      note: "Runs the Open OTA migrations against the linked project's Postgres.",
    },
    {
      title: "Create the bundle bucket",
      command: ["supabase", "storage", "create", `ss:///${context.bucket}`],
      destructive: true,
      note: "Older CLIs have no storage command — create the bucket in the dashboard (Storage → New bucket, public) if this fails.",
    },
    {
      title: "Set the function secrets",
      command: [
        "supabase",
        "secrets",
        "set",
        `OTA_MASTER_KEY=${context.masterKey}`,
        "OTA_MODE=self",
        `STORAGE_BUCKET=${context.bucket}`,
      ],
      destructive: true,
      note: "OTA_MASTER_KEY encrypts every project's private signing key. Losing it means re-keying and rebuilding the apps — store a copy.",
    },
    {
      title: "Deploy the Edge Function",
      command: ["supabase", "functions", "deploy", "ota", "--no-verify-jwt"],
      destructive: true,
      note: "The function does its own Bearer auth; Supabase JWT verification would reject CLI tokens.",
    },
  ],
};
