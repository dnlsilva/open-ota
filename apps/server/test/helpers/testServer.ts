/**
 * Integration harness: a real PostgreSQL engine (PGlite, in-process WASM) with
 * the real schema, so these tests exercise the actual SQL — the upsert
 * throttle, the counter arithmetic and the update-check indexes — instead of a
 * mock that agrees with whatever the code does.
 */

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { generateMasterKey } from "@open-ota/shared";
import { loadConfig, type AppConfig } from "../../src/config.js";
import { schema } from "../../src/db/schema.js";
import type { AppContext } from "../../src/services/context.js";
import type { StorageAdapter } from "../../src/storage/index.js";
import { seedPlans } from "../../src/services/orgs.js";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface TestHarness {
  ctx: AppContext;
  storage: MemoryStorage;
  setNow: (date: Date) => void;
  close: () => Promise<void>;
}

export class MemoryStorage implements StorageAdapter {
  readonly name = "memory";
  readonly readsAreCheap = true;
  private readonly objects = new Map<string, Uint8Array>();

  async createSignedUploadUrl(key: string) {
    return { url: `memory://${key}`, headers: { "content-type": "application/zip" } };
  }
  publicUrl(key: string) {
    return `https://cdn.test/${key}`;
  }
  async head(key: string) {
    const value = this.objects.get(key);
    return value ? { size: value.length } : null;
  }
  async get(key: string) {
    return this.objects.get(key) ?? null;
  }
  async put(key: string, body: Uint8Array) {
    this.objects.set(key, body);
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  /** Stand-in for the client PUT-ing straight to the bucket. */
  upload(key: string, body: Uint8Array) {
    this.objects.set(key, body);
  }
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

async function loadMigrations(): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const statements: string[] = [];
  for (const file of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    statements.push(sql.replace(/--> statement-breakpoint/g, ""));
  }
  return statements;
}

export async function createTestHarness(
  overrides: Partial<Record<string, string>> = {},
): Promise<TestHarness> {
  const client = new PGlite();
  // Run the same migrations production runs, rather than a schema copy that
  // could drift away from them.
  for (const statement of await loadMigrations()) await client.exec(statement);

  const db = drizzle(client, { schema }) as unknown as AppContext["db"];
  const config: AppConfig = loadConfig({
    DATABASE_URL: "postgres://pglite/test",
    OTA_MASTER_KEY: generateMasterKey(),
    STORAGE_DRIVER: "local",
    PUBLIC_URL: "https://ota.test",
    ...overrides,
  });

  const storage = new MemoryStorage();
  let clock = new Date("2026-08-27T12:00:00.000Z");

  const ctx: AppContext = {
    db,
    storage,
    config,
    email: { async send() {} },
    now: () => clock,
  };

  await seedPlans(ctx);

  return {
    ctx,
    storage,
    setNow: (date) => {
      clock = date;
    },
    close: () => client.close(),
  };
}
