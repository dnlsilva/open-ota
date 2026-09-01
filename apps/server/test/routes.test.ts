/**
 * Route tests for the storage passthrough, Stripe billing and the OAuth
 * authorization server. Real PostgreSQL (PGlite) through the shared harness —
 * webhook idempotency and single-use codes are ON CONFLICT and DELETE
 * behaviour, which a mock can only agree with.
 */

import { bytesToBase64Url, sha256Hex } from "@open-ota/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import type { AppEnv } from "../src/app.js";
import { apiTokens, oauthClients, oauthCodes, orgs, plans, releases } from "../src/db/schema.js";
import { MCP_TOOLS } from "../src/mcp/tools.js";
import { billingRoutes } from "../src/routes/billing.js";
import { mcpRoutes } from "../src/routes/mcp.js";
import { oauthRoutes } from "../src/routes/oauth.js";
import { storageRoutes } from "../src/routes/storage.js";
import { createOrg, issueToken } from "../src/services/auth.js";
import type { Actor, AppContext } from "../src/services/context.js";
import { ApiError } from "../src/services/errors.js";
import { createProject } from "../src/services/projects.js";
import { prepareUpload } from "../src/services/releases.js";
import { hashPassword } from "../src/services/password.js";
import { users } from "../src/db/schema.js";
import { createLocalStorage } from "../src/storage/local.js";
import { createTestHarness, MemoryStorage, type TestHarness } from "./helpers/testServer.js";
import { uuidv7 } from "@open-ota/shared";

/** Mounts one router with ctx (and an actor) already in place. */
function mount(ctx: AppContext, routes: Hono<AppEnv>, actor?: Actor) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("ctx", ctx);
    if (actor) c.set("actor", actor);
    await next();
  });

  // Same shape as app.ts, so tests see the errors clients actually get.
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    }
    if (err instanceof ZodError) {
      return c.json({ error: { code: "invalid_request", message: "Invalid request body" } }, 400);
    }
    throw err;
  });

  app.route("/", routes);
  return app;
}

const PASSWORD = "correct-horse-battery-staple";

async function seedAccount(ctx: AppContext, email = "dev@example.test") {
  const userId = uuidv7();
  await ctx.db.insert(users).values({
    id: userId,
    email,
    passwordHash: await hashPassword(PASSWORD),
    emailVerifiedAt: ctx.now(),
  });
  const org = await createOrg(ctx, userId, "Acme");
  const actor: Actor = { userId, orgId: org.id, tokenId: uuidv7(), scopes: ["admin"], projectId: null };
  return { userId, orgId: org.id, email, actor };
}

/* ------------------------------------------------------------------ oauth */

const VERIFIER = "z-nS4wCkR8h1QpX7vJm2Ld0TgYbEuAoIcFhKrNsVeWq";

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return bytesToBase64Url(new Uint8Array(digest));
}

describe("oauth", () => {
  const REDIRECT = "http://localhost:6274/callback";
  const CLIENT_ID = "mcp_test_client";

  let harness: TestHarness;
  let app: ReturnType<typeof mount>;
  let account: Awaited<ReturnType<typeof seedAccount>>;
  let challenge: string;

  beforeAll(async () => {
    harness = await createTestHarness({ OTA_MODE: "self" });
    app = mount(harness.ctx, oauthRoutes());
    account = await seedAccount(harness.ctx);
    challenge = await s256(VERIFIER);

    await harness.ctx.db.insert(oauthClients).values({
      id: CLIENT_ID,
      clientName: "Example MCP Client",
      redirectUris: [REDIRECT, "cursor://anysphere/oauth"],
    });
  });

  afterAll(() => harness.close());

  function authorizeQuery(overrides: Record<string, string> = {}) {
    return new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "opaque-state",
      ...overrides,
    }).toString();
  }

  function form(body: Record<string, string>) {
    return {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    };
  }

  /** Fresh code row per test, so single-use assertions do not leak across them. */
  async function issueCode(overrides: Record<string, unknown> = {}) {
    const code = `otac_${uuidv7()}`;
    await harness.ctx.db.insert(oauthCodes).values({
      code,
      clientId: CLIENT_ID,
      userId: account.userId,
      orgId: account.orgId,
      redirectUri: REDIRECT,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      scope: "admin",
      expiresAt: new Date(harness.ctx.now().getTime() + 60_000),
      ...overrides,
    });
    return code;
  }

  function exchange(code: string, overrides: Record<string, string> = {}) {
    return form({
      grant_type: "authorization_code",
      code,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
      ...overrides,
    });
  }

  it("renders the consent page for a registered redirect_uri", async () => {
    const res = await app.request(`/authorize?${authorizeQuery()}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Example MCP Client");
    expect(html).toContain(`name="code_challenge" value="${challenge}"`);
  });

  it("matches redirect_uri exactly, not by prefix or origin", async () => {
    for (const redirect of [
      `${REDIRECT}/extra`,
      `${REDIRECT}?x=1`,
      "http://localhost:6274",
      "https://evil.example/callback",
      "",
    ]) {
      const res = await app.request(`/authorize?${authorizeQuery({ redirect_uri: redirect })}`);
      expect(res.status, redirect).toBe(400);
      expect(await res.json()).toEqual({
        error: "invalid_request",
        error_description: "redirect_uri is not registered for this client",
      });
    }
  });

  it("refuses anything but PKCE with S256", async () => {
    const plain = await app.request(`/authorize?${authorizeQuery({ code_challenge_method: "plain" })}`);
    expect(plain.status).toBe(400);
    expect((await plain.json()).error).toBe("invalid_request");

    const query = new URLSearchParams(authorizeQuery());
    query.delete("code_challenge");
    expect((await app.request(`/authorize?${query}`)).status).toBe(400);

    const wrongType = await app.request(`/authorize?${authorizeQuery({ response_type: "token" })}`);
    expect(wrongType.status).toBe(400);
    expect((await wrongType.json()).error).toBe("unsupported_response_type");
  });

  it("reports an unknown client in the OAuth error shape", async () => {
    const res = await app.request(`/authorize?${authorizeQuery({ client_id: "mcp_nobody" })}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_client" });
  });

  it("redirects with a code and the state after a correct password", async () => {
    const res = await app.request(
      "/authorize",
      form({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "opaque-state",
        scope: "admin",
        email: account.email,
        password: PASSWORD,
      }),
    );

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get("state")).toBe("opaque-state");

    const code = location.searchParams.get("code")!;
    const stored = await harness.ctx.db.query.oauthCodes.findFirst({ where: eq(oauthCodes.code, code) });
    expect(stored?.codeChallenge).toBe(challenge);

    // Consent must not leave a stray session credential behind.
    expect(await harness.ctx.db.select().from(apiTokens)).toHaveLength(0);
  });

  it("re-renders the form on a wrong password instead of issuing a code", async () => {
    const res = await app.request(
      "/authorize",
      form({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        email: account.email,
        password: "not-the-password",
      }),
    );

    expect(res.status).toBe(401);
    expect(await res.text()).toContain("Wrong email or password");
  });

  it("accepts the code_verifier that produced the stored challenge", async () => {
    const res = await app.request("/token", exchange(await issueCode()));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token_type).toBe("Bearer");
    expect(body.access_token).toMatch(/^ota_/);
    expect(body.refresh_token).toMatch(/^otar_/);
    expect(body.scope).toBe("admin");
    expect(body.expires_in).toBeGreaterThan(0);

    // The access token is an ordinary api_tokens row carrying the refresh hash.
    const token = await harness.ctx.db.query.apiTokens.findFirst({ where: eq(apiTokens.kind, "oauth") });
    expect(token?.refreshTokenHash).toEqual(expect.any(String));
    expect(token?.orgId).toBe(account.orgId);
  });

  it("rejects a code_verifier that does not hash to the challenge", async () => {
    const res = await app.request("/token", exchange(await issueCode(), { code_verifier: `${VERIFIER}x` }));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("burns the code on use, and on a failed use", async () => {
    const reused = await issueCode();
    expect((await app.request("/token", exchange(reused))).status).toBe(200);
    const replay = await app.request("/token", exchange(reused));
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });

    const attacked = await issueCode();
    await app.request("/token", exchange(attacked, { code_verifier: `${VERIFIER}wrong` }));
    expect((await app.request("/token", exchange(attacked))).status).toBe(400);
  });

  it("rejects an expired code", async () => {
    const stale = await issueCode({ expiresAt: new Date(harness.ctx.now().getTime() - 1_000) });
    const res = await app.request("/token", exchange(stale));

    expect(res.status).toBe(400);
    expect((await res.json()).error_description).toContain("expired");
  });

  it("rejects a code replayed by another client or to another redirect_uri", async () => {
    const wrongClient = await app.request("/token", exchange(await issueCode(), { client_id: "mcp_other" }));
    expect(wrongClient.status).toBe(400);

    const wrongRedirect = await app.request(
      "/token",
      exchange(await issueCode(), { redirect_uri: `${REDIRECT}/extra` }),
    );
    expect(wrongRedirect.status).toBe(400);
  });

  it("rotates the token pair on refresh_token", async () => {
    const first = await (await app.request("/token", exchange(await issueCode()))).json();
    const res = await app.request(
      "/token",
      form({ grant_type: "refresh_token", refresh_token: first.refresh_token }),
    );

    expect(res.status).toBe(200);
    const next = await res.json();
    expect(next.access_token).not.toBe(first.access_token);
    expect(next.refresh_token).not.toBe(first.refresh_token);

    // The old pair is gone, not merely superseded.
    expect((await app.request("/token", form({ grant_type: "refresh_token", refresh_token: first.refresh_token }))).status).toBe(400);
  });

  it("rejects an unsupported grant", async () => {
    const res = await app.request("/token", form({ grant_type: "password" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "unsupported_grant_type" });
  });

  it("registers a public client and returns a usable client_id", async () => {
    const res = await app.request("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Cursor", redirect_uris: ["cursor://cb"] }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.client_id).toEqual(expect.any(String));

    const authorize = await app.request(
      `/authorize?${new URLSearchParams({
        client_id: body.client_id,
        redirect_uri: "cursor://cb",
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
      })}`,
    );
    expect(authorize.status).toBe(200);
  });
});

/* ---------------------------------------------------------------- billing */

const WEBHOOK_SECRET = "whsec_test_secret";

function signed(payload: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(`${timestamp}.${payload}`).digest("hex");
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": `t=${timestamp},v1=${signature}`,
    },
    body: payload,
  };
}

function subscriptionEvent(id: string, orgId: string) {
  return JSON.stringify({
    id,
    object: "event",
    type: "customer.subscription.updated",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: "sub_test",
        object: "subscription",
        customer: "cus_test",
        status: "active",
        current_period_end: 1_800_000_000,
        cancel_at_period_end: false,
        metadata: { orgId },
        items: { object: "list", data: [{ id: "si_test", price: { id: "price_pro" } }] },
      },
    },
  });
}

describe("billing when it is switched off", () => {
  it("answers 400 on every route but the webhook", async () => {
    // Self-hosted, and hosted-without-Stripe: neither is metered.
    for (const env of [{ OTA_MODE: "self" }, { OTA_MODE: "hosted" }]) {
      const harness = await createTestHarness(env);
      const account = await seedAccount(harness.ctx);
      const app = mount(harness.ctx, billingRoutes(), account.actor);

      for (const path of ["/checkout", "/portal"]) {
        const res = await app.request(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ orgId: account.orgId, planId: "pro" }),
        });

        expect(res.status, `${env.OTA_MODE} ${path}`).toBe(400);
        const body = await res.json();
        expect(body.error.code).toBe("billing_disabled");
        expect(body.error.message).toContain("not enabled");
      }

      await harness.close();
    }
  });
});

describe("billing webhook", () => {
  let harness: TestHarness;
  let app: ReturnType<typeof mount>;
  let orgId: string;

  beforeAll(async () => {
    harness = await createTestHarness({
      OTA_MODE: "hosted",
      STRIPE_SECRET_KEY: "sk_test_key",
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    });
    const account = await seedAccount(harness.ctx);
    orgId = account.orgId;
    app = mount(harness.ctx, billingRoutes(), account.actor);

    await harness.ctx.db
      .update(plans)
      .set({ stripePriceId: "price_pro" })
      .where(eq(plans.id, "pro"));
  });

  afterAll(() => harness.close());

  const planOf = async () =>
    (await harness.ctx.db.query.orgs.findFirst({ where: eq(orgs.id, orgId) }))?.planId;

  it("applies an event once, however many times Stripe redelivers it", async () => {
    const payload = subscriptionEvent("evt_repeat", orgId);

    const first = await app.request("/webhook", signed(payload));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ received: true });
    expect(await planOf()).toBe("pro");

    // Move the state back, so a redelivery that re-applied would be visible.
    await harness.ctx.db.update(orgs).set({ planId: "free" }).where(eq(orgs.id, orgId));

    const second = await app.request("/webhook", signed(payload));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ received: true, duplicate: true });
    expect(await planOf()).toBe("free");
  });

  it("mirrors the subscription and takes the plan from the price", async () => {
    await app.request("/webhook", signed(subscriptionEvent("evt_mirror", orgId)));

    expect(await planOf()).toBe("pro");
    const mirrored = await harness.ctx.db.query.subscriptions.findFirst();
    expect(mirrored).toMatchObject({
      orgId,
      stripeCustomerId: "cus_test",
      stripeSubscriptionId: "sub_test",
      status: "active",
      cancelAtPeriodEnd: false,
    });
  });

  it("refuses a payload Stripe did not sign", async () => {
    const res = await app.request("/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=deadbeef" },
      body: subscriptionEvent("evt_forged", orgId),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_signature");
  });
});

/* ---------------------------------------------------------------- storage */

describe("storage passthrough", () => {
  let harness: TestHarness;
  let app: ReturnType<typeof mount>;
  let dir: string;
  let key: string;
  let releaseId: string;
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "open-ota-storage-"));
    harness = await createTestHarness({ OTA_MODE: "self", STORAGE_LOCAL_DIR: dir });
    // The real driver, so the route is exercised against what it exists for.
    harness.ctx.storage = createLocalStorage(harness.ctx.config);
    app = mount(harness.ctx, storageRoutes());

    const account = await seedAccount(harness.ctx);
    const project = await createProject(harness.ctx, { orgId: account.orgId, name: "Demo" });
    const prepared = await prepareUpload(harness.ctx, {
      projectId: project.id,
      platform: "ios",
      channel: "production",
      runtimeVersion: "fp_test",
      sha256: await sha256Hex(bytes),
      size: bytes.byteLength,
    });
    key = prepared.storageKey;
    releaseId = prepared.releaseId;
  });

  afterAll(async () => {
    await harness.close();
    await rm(dir, { recursive: true, force: true });
  });

  const setStatus = (status: string) =>
    harness.ctx.db.update(releases).set({ status }).where(eq(releases.id, releaseId));

  it("accepts a bundle for a pending release and serves it back immutably", async () => {
    const put = await app.request(`/${encodeURIComponent(key)}`, { method: "PUT", body: bytes });
    expect(put.status).toBe(201);

    const get = await app.request(`/${encodeURIComponent(key)}`);
    expect(get.status).toBe(200);
    expect(get.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(get.headers.get("content-type")).toContain("application/zip");
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);
  });

  it("accepts the key as raw path segments too", async () => {
    const res = await app.request(`/${key}`, { method: "PUT", body: bytes });
    expect(res.status).toBe(201);
  });

  it("refuses an upload once the release is no longer pending", async () => {
    for (const status of ["active", "paused", "disabled"]) {
      await setStatus(status);
      const res = await app.request(`/${encodeURIComponent(key)}`, { method: "PUT", body: bytes });

      expect(res.status, status).toBe(409);
      expect((await res.json()).error.code).toBe("release_not_pending");
    }
    await setStatus("pending");
  });

  it("refuses an upload with no release behind it", async () => {
    const orphan = `bundles/${uuidv7()}/${uuidv7()}.zip`;
    const res = await app.request(`/${encodeURIComponent(orphan)}`, { method: "PUT", body: bytes });

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("release_not_found");
  });

  it("refuses a key that is not shaped like a bundle key", async () => {
    const [, projectId, file] = key.split("/");
    const releaseFile = file!.replace(".zip", "");

    for (const bad of [
      "bundles/../../etc/passwd.zip",
      "bundles/%2e%2e/%2e%2e/secret.zip",
      `../${key}`,
      `${key}/../../escape.zip`,
      `bundles/${projectId}/${releaseFile}.js`,
      `${key}extra`,
      "etc/passwd",
    ]) {
      const res = await app.request(`/${encodeURIComponent(bad)}`, { method: "PUT", body: bytes });
      expect(res.status, bad).toBe(400);
      expect((await res.json()).error.code).toBe("invalid_key");
    }
  });

  it("stays dark when the driver can sign its own URLs", async () => {
    const signing = mount({ ...harness.ctx, storage: new MemoryStorage() }, storageRoutes());
    const res = await signing.request(`/${encodeURIComponent(key)}`, { method: "PUT", body: bytes });

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("storage_passthrough_disabled");
  });
});

/* -------------------------------------------------------------------- mcp */

describe("mcp endpoint", () => {
  let harness: TestHarness;
  let app: ReturnType<typeof mount>;
  let token: string;
  let projectId: string;

  beforeAll(async () => {
    harness = await createTestHarness({ OTA_MODE: "self" });
    app = mount(harness.ctx, mcpRoutes());

    const account = await seedAccount(harness.ctx);
    const project = await createProject(harness.ctx, { orgId: account.orgId, name: "Demo" });
    projectId = project.id;
    token = (
      await issueToken(harness.ctx, {
        userId: account.userId,
        orgId: account.orgId,
        name: "mcp",
        scopes: ["admin"],
      })
    ).token;
  });

  afterAll(() => harness.close());

  function rpc(body: unknown, bearer = token) {
    return app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  it("points an unauthenticated client at the OAuth metadata", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "");

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${harness.ctx.config.publicUrl}/.well-known/oauth-protected-resource"`,
    );
    expect((await res.json()).error).toBe("invalid_token");
  });

  it("initializes and lists every tool", async () => {
    const init = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    expect(init.status).toBe(200);
    expect((await init.json()).result.serverInfo.name).toBe("open-ota");

    const listed = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = (await listed.json()).result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(MCP_TOOLS.map((t) => t.name));
    expect(names).toContain("set_rollout_percentage");
  });

  it("runs a tool against the service layer", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_projects", arguments: {} },
    });

    const result = (await res.json()).result;
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text).projects[0].id).toBe(projectId);
  });

  it("reports an ApiError as tool output rather than a transport failure", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "get_project", arguments: { projectId: uuidv7() } },
    });

    const result = (await res.json()).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("project_not_found");
  });
});
