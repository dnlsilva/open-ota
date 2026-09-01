/**
 * Runtime configuration. The same build runs self-hosted (single org, no
 * billing) and hosted (multi-tenant with Stripe); OTA_MODE decides which.
 */

import { z } from "zod";

export const MODES = ["self", "hosted"] as const;
export type Mode = (typeof MODES)[number];

const envSchema = z.object({
  OTA_MODE: z.enum(MODES).default("self"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),

  /** 32 random bytes, base64. Seals project private keys at rest. */
  OTA_MASTER_KEY: z.string().min(1),
  /** Public base URL of this server, used to build OAuth and preview URLs. */
  PUBLIC_URL: z.string().url().optional(),

  STORAGE_DRIVER: z.enum(["s3", "supabase", "local"]).default("s3"),
  STORAGE_ENDPOINT: z.string().optional(),
  STORAGE_REGION: z.string().default("auto"),
  STORAGE_BUCKET: z.string().default("ota-bundles"),
  STORAGE_ACCESS_KEY: z.string().optional(),
  STORAGE_SECRET_KEY: z.string().optional(),
  STORAGE_FORCE_PATH_STYLE: z.coerce.boolean().default(false),
  STORAGE_LOCAL_DIR: z.string().default(".ota/bundles"),
  /** CDN origin in front of the bucket. Bundles are immutable, so cache hard. */
  PUBLIC_BUNDLE_BASE_URL: z.string().url().optional(),

  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PORTAL_RETURN_URL: z.string().url().optional(),

  // console prints to the server log; resend sends. No smtp driver exists —
  // implement it before adding it back here, or the value would silently no-op.
  EMAIL_DRIVER: z.enum(["console", "resend"]).default("console"),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("Open OTA <noreply@localhost>"),

  DASHBOARD_DIR: z.string().optional(),
  /** Extra origins allowed to call the admin API (the `ota console` port). */
  CORS_ORIGINS: z.string().default("*"),
});

export type Env = z.infer<typeof envSchema>;

export interface AppConfig extends Env {
  mode: Mode;
  hosted: boolean;
  billingEnabled: boolean;
  publicUrl: string;
}

export function loadConfig(raw: Record<string, string | undefined>): AppConfig {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");
    throw new Error(`Invalid server configuration:\n  ${missing}`);
  }
  const env = parsed.data;
  const hosted = env.OTA_MODE === "hosted";

  if (hosted && !env.PUBLIC_URL) {
    throw new Error("PUBLIC_URL is required in hosted mode (OAuth and checkout redirects need it)");
  }

  return {
    ...env,
    mode: env.OTA_MODE,
    hosted,
    billingEnabled: hosted && Boolean(env.STRIPE_SECRET_KEY),
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${env.PORT}`).replace(/\/+$/, ""),
  };
}

export function corsOrigins(config: AppConfig): string[] | "*" {
  if (config.CORS_ORIGINS.trim() === "*") return "*";
  return config.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
}
