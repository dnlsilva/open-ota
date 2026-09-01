/**
 * A full Open OTA server on an in-process Postgres, with a week of plausible
 * traffic already in it. No Docker, no bucket, no config:
 *
 *   pnpm --filter @open-ota/server demo
 *
 * It exists so the dashboard can be opened and clicked through in one command —
 * and it is the same code path production runs, not a mock.
 */

import { PGlite } from "@electric-sql/pglite";
import { serve } from "@hono/node-server";
import { generateMasterKey, sha256Hex, utf8, uuidv7 } from "@open-ota/shared";
import { drizzle } from "drizzle-orm/pglite";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { devices, orgs, orgMembers, releaseStats, rollbackEvents, schema, users } from "../src/db/schema.js";
import { hashPassword } from "../src/services/password.js";
import { seedPlans } from "../src/services/orgs.js";
import { createProject } from "../src/services/projects.js";
import { confirmRelease, prepareUpload } from "../src/services/releases.js";
import { issueToken } from "../src/services/auth.js";
import type { AppContext } from "../src/services/context.js";
import type { StorageAdapter } from "../src/storage/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const EMAIL = "demo@open-ota.dev";
const PASSWORD = "demo-password-1234";
const RUNTIME = "fp_4a9c17e2b8";

class MemoryStorage implements StorageAdapter {
  readonly name = "memory";
  readonly readsAreCheap = true;
  private readonly objects = new Map<string, Uint8Array>();
  async createSignedUploadUrl(key: string) {
    return { url: `memory://${key}`, headers: {}, viaServer: true };
  }
  publicUrl(key: string) {
    return `https://cdn.demo.local/${key}`;
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
}

/** Deterministic pseudo-randomness, so the demo looks the same every run. */
function rng(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

async function main() {
  const client = new PGlite();
  const migrations = (await readdir(join(HERE, "../drizzle"))).filter((f) => f.endsWith(".sql")).sort();
  for (const file of migrations) {
    await client.exec((await readFile(join(HERE, "../drizzle", file), "utf8")).replace(/--> statement-breakpoint/g, ""));
  }

  const storage = new MemoryStorage();
  let now = new Date();
  const ctx: AppContext = {
    db: drizzle(client, { schema }) as unknown as AppContext["db"],
    storage,
    config: loadConfig({
      DATABASE_URL: "postgres://pglite/demo",
      OTA_MASTER_KEY: generateMasterKey(),
      STORAGE_DRIVER: "local",
      PUBLIC_URL: `http://localhost:${PORT}`,
      PORT: String(PORT),
    }),
    email: { async send(message) { console.log(`  [email] ${message.subject} → ${message.to}`); } },
    now: () => now,
  };

  await seedPlans(ctx);

  const userId = uuidv7();
  const orgId = uuidv7();
  await ctx.db.insert(users).values({
    id: userId,
    email: EMAIL,
    passwordHash: await hashPassword(PASSWORD),
    emailVerifiedAt: now,
  });
  await ctx.db.insert(orgs).values({ id: orgId, name: "Acme Mobile", slug: "acme-mobile", planId: "free" });
  await ctx.db.insert(orgMembers).values({ orgId, userId, role: "owner" });

  const project = await createProject(ctx, { orgId, name: "Acme Delivery", deepLinkScheme: "acmedelivery" });
  const { token } = await issueToken(ctx, { userId, orgId, name: "demo", scopes: ["admin"] });

  // Six releases across two platforms, published over the past week.
  const startedAt = Date.now() - 7 * 86_400_000;
  const published: Array<{ id: string; label: number; platform: "ios" | "android"; day: number }> = [];

  for (let day = 0; day < 6; day++) {
    now = new Date(startedAt + day * 86_400_000);
    for (const platform of ["ios", "android"] as const) {
      // Real bytes, so confirm() re-hashes them exactly as it would in production.
      const body = utf8(`bundle-${platform}-${day}-`.padEnd(4_100_000 + day * 190_000, "x"));
      const prepared = await prepareUpload(ctx, {
        projectId: project.id,
        platform,
        channel: day < 4 ? "production" : "staging",
        runtimeVersion: RUNTIME,
        sha256: await sha256Hex(body),
        size: body.length,
        createdBy: userId,
        rolloutPercent: day === 5 ? 10 : 100,
        message: [
          "Faster cart sync",
          "Fix crash on empty address book",
          "New order tracking screen",
          "Reduce cold start by 400ms",
          "Payment retry flow",
          "Live courier map",
        ][day],
      });
      await storage.put(prepared.storageKey, body);
      const confirmed = await confirmRelease(ctx, prepared.releaseId);
      published.push({ id: confirmed.id, label: confirmed.label, platform, day });
    }
  }

  now = new Date();

  // A device population that produces a believable distribution: most on the
  // newest production release, a tail on older ones, a few still embedded.
  const random = rng(20260901);
  const NATIVE = ["1.4.2", "1.4.1", "1.3.9"];
  const productionReleases = published.filter((r) => r.day < 4);

  const deviceRows = [];
  for (let i = 0; i < 4_200; i++) {
    const platform = random() < 0.55 ? "android" : ("ios" as const);
    const pool = productionReleases.filter((r) => r.platform === platform).sort((a, b) => b.day - a.day);
    const roll = random();
    const pick = roll < 0.78 ? pool[0] : roll < 0.9 ? pool[1] : roll < 0.97 ? pool[2] : null;
    deviceRows.push({
      id: `device-${i}`,
      projectId: project.id,
      platform,
      channel: "production",
      nativeVersion: NATIVE[roll < 0.8 ? 0 : roll < 0.95 ? 1 : 2]!,
      runtimeVersion: RUNTIME,
      currentReleaseId: pick?.id ?? null,
      firstSeenAt: new Date(now.getTime() - random() * 30 * 86_400_000),
      lastSeenAt: new Date(now.getTime() - random() * 2 * 86_400_000),
    });
  }
  for (let i = 0; i < deviceRows.length; i += 500) {
    await ctx.db.insert(devices).values(deviceRows.slice(i, i + 500));
  }

  // Daily counters with a healthy funnel, and one release that went badly.
  const troubled = published.find((r) => r.day === 3 && r.platform === "android")!;
  for (const release of published) {
    for (let d = release.day; d < 7; d++) {
      const day = new Date(startedAt + d * 86_400_000).toISOString().slice(0, 10);
      const scale = d === release.day ? 1 : 0.35 ** (d - release.day);
      const installs = Math.round((420 + random() * 260) * scale);
      if (installs < 3) continue;
      const bad = release.id === troubled.id;
      const rollbacks = Math.round(installs * (bad ? 0.061 : 0.003 * random()));
      await ctx.db.insert(releaseStats).values({
        releaseId: release.id,
        day,
        downloads: installs + Math.round(installs * 0.04),
        installs,
        ready: installs - rollbacks - Math.round(installs * 0.002),
        failed: rollbacks,
        rollbacks,
      });
      for (let k = 0; k < Math.min(rollbacks, 4); k++) {
        await ctx.db.insert(rollbackEvents).values({
          id: uuidv7(),
          projectId: project.id,
          releaseId: release.id,
          fromReleaseId: null,
          deviceId: `device-${Math.floor(random() * 4200)}`,
          reason: "crash",
          meta: { platform: release.platform, nativeVersion: "1.4.2", message: "TypeError: undefined is not an object" },
          createdAt: new Date(startedAt + d * 86_400_000 + k * 3_600_000),
        });
      }
    }
  }

  const app = createApp(ctx);
  serve({ fetch: app.fetch, port: PORT }, () => {
    console.log(`\n  Open OTA demo server on http://localhost:${PORT}`);
    console.log(`  sign in with  ${EMAIL} / ${PASSWORD}`);
    console.log(`  project       ${project.name} (${project.id})`);
    console.log(`  api token     ${token}`);
    console.log(`\n  Start the dashboard against it:  pnpm --filter @open-ota/dashboard dev\n`);
  });
}

await main();
