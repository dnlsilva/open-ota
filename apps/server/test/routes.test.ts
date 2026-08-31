import { bytesToBase64Url } from "@open-ota/shared";
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { billingRoutes } from "../src/routes/billing.js";
import { oauthRoutes } from "../src/routes/oauth.js";
import { storageRoutes } from "../src/routes/storage.js";
import { fakeContext, fakeDb, fakeStorage, mount, TEST_ACTOR } from "./fakes.js";

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return bytesToBase64Url(new Uint8Array(digest));
}

/* ------------------------------------------------------------------ oauth */

const VERIFIER = "z-nS4wCkR8h1QpX7vJm2Ld0TgYbEuAoIcFhKrNsVeWq";
const CHALLENGE = await s256(VERIFIER);

const CLIENT = {
  id: "mcp_test_client",
  clientName: "Claude Code",
  redirectUris: ["http://localhost:6274/callback", "cursor://anysphere/oauth"],
  createdAt: new Date("2026-09-01T00:00:00Z"),
};

const NOW = new Date("2026-09-01T12:00:00Z");

function codeRow(overrides: Record<string, unknown> = {}) {
  return {
    code: "otac_testcode",
    clientId: CLIENT.id,
    userId: TEST_ACTOR.userId,
    orgId: TEST_ACTOR.orgId,
    redirectUri: CLIENT.redirectUris[0]!,
    codeChallenge: CHALLENGE,
    codeChallengeMethod: "S256",
    scope: "admin",
    expiresAt: new Date(NOW.getTime() + 60_000),
    createdAt: NOW,
    ...overrides,
  };
}

function oauthApp(seed: Parameters<typeof fakeDb>[0]) {
  const { ctx, db } = fakeContext({ db: fakeDb(seed), now: NOW });
  return { app: mount(ctx, oauthRoutes()), db };
}

function authorizeQuery(overrides: Record<string, string> = {}) {
  return new URLSearchParams({
    client_id: CLIENT.id,
    redirect_uri: CLIENT.redirectUris[0]!,
    response_type: "code",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "opaque-state",
    ...overrides,
  }).toString();
}

function tokenForm(body: Record<string, string>) {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  };
}

function exchange(overrides: Record<string, string> = {}) {
  return tokenForm({
    grant_type: "authorization_code",
    code: "otac_testcode",
    client_id: CLIENT.id,
    redirect_uri: CLIENT.redirectUris[0]!,
    code_verifier: VERIFIER,
    ...overrides,
  });
}

describe("oauth /authorize", () => {
  it("renders the consent page for a registered redirect_uri", async () => {
    const { app } = oauthApp({ oauthClients: [CLIENT] });
    const res = await app.request(`/authorize?${authorizeQuery()}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Claude Code");
    expect(html).toContain(`name="code_challenge" value="${CHALLENGE}"`);
  });

  it("matches redirect_uri exactly, not by prefix or origin", async () => {
    const { app } = oauthApp({ oauthClients: [CLIENT] });

    for (const redirect of [
      "http://localhost:6274/callback/extra",
      "http://localhost:6274/callback?x=1",
      "http://localhost:6274",
      "https://evil.example/callback",
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
    const { app } = oauthApp({ oauthClients: [CLIENT] });

    const plain = await app.request(`/authorize?${authorizeQuery({ code_challenge_method: "plain" })}`);
    expect(plain.status).toBe(400);
    expect((await plain.json()).error).toBe("invalid_request");

    const query = new URLSearchParams(authorizeQuery());
    query.delete("code_challenge");
    const missing = await app.request(`/authorize?${query}`);
    expect(missing.status).toBe(400);

    const wrongType = await app.request(`/authorize?${authorizeQuery({ response_type: "token" })}`);
    expect(wrongType.status).toBe(400);
    expect((await wrongType.json()).error).toBe("unsupported_response_type");
  });

  it("reports an unknown client with the OAuth error shape", async () => {
    const { app } = oauthApp({ oauthClients: [] });
    const res = await app.request(`/authorize?${authorizeQuery()}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_client" });
  });
});

describe("oauth /token", () => {
  it("accepts the code_verifier that produced the stored challenge", async () => {
    const { app, db } = oauthApp({ oauthClients: [CLIENT], oauthCodes: [codeRow()] });
    const res = await app.request("/token", exchange());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token_type).toBe("Bearer");
    expect(body.access_token).toMatch(/^ota_/);
    expect(body.refresh_token).toMatch(/^otar_/);
    expect(body.scope).toBe("admin");
    expect(body.expires_in).toBeGreaterThan(0);

    // The access token is a normal api_tokens row carrying the refresh hash.
    expect(db.rows.apiTokens).toHaveLength(1);
    expect(db.rows.apiTokens?.[0]!.kind).toBe("oauth");
    expect(db.rows.apiTokens?.[0]!.refreshTokenHash).toEqual(expect.any(String));
  });

  it("rejects a code_verifier that does not hash to the challenge", async () => {
    const { app, db } = oauthApp({ oauthClients: [CLIENT], oauthCodes: [codeRow()] });
    const res = await app.request("/token", exchange({ code_verifier: `${VERIFIER}x` }));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
    expect(db.rows.apiTokens).toHaveLength(0);
  });

  it("burns the code on use, and on a failed use", async () => {
    const reused = oauthApp({ oauthClients: [CLIENT], oauthCodes: [codeRow()] });
    expect((await reused.app.request("/token", exchange())).status).toBe(200);
    const second = await reused.app.request("/token", exchange());
    expect(second.status).toBe(400);
    expect(await second.json()).toMatchObject({ error: "invalid_grant" });

    const attacked = oauthApp({ oauthClients: [CLIENT], oauthCodes: [codeRow()] });
    await attacked.app.request("/token", exchange({ code_verifier: "wrong-verifier-wrong-verifier-wrong-verifier" }));
    const honest = await attacked.app.request("/token", exchange());
    expect(honest.status).toBe(400);
  });

  it("rejects an expired code", async () => {
    const { app } = oauthApp({
      oauthClients: [CLIENT],
      oauthCodes: [codeRow({ expiresAt: new Date(NOW.getTime() - 1_000) })],
    });
    const res = await app.request("/token", exchange());

    expect(res.status).toBe(400);
    expect((await res.json()).error_description).toContain("expired");
  });

  it("rejects a code replayed by another client or to another redirect_uri", async () => {
    const wrongClient = oauthApp({ oauthClients: [CLIENT], oauthCodes: [codeRow()] });
    expect((await wrongClient.app.request("/token", exchange({ client_id: "mcp_other" }))).status).toBe(400);

    const wrongRedirect = oauthApp({ oauthClients: [CLIENT], oauthCodes: [codeRow()] });
    const res = await wrongRedirect.app.request(
      "/token",
      exchange({ redirect_uri: "http://localhost:6274/callback/extra" }),
    );
    expect(res.status).toBe(400);
  });

  it("rotates the token pair on refresh_token", async () => {
    const { app, db } = oauthApp({ oauthClients: [CLIENT], oauthCodes: [codeRow()] });
    const first = await (await app.request("/token", exchange())).json();

    const res = await app.request(
      "/token",
      tokenForm({ grant_type: "refresh_token", refresh_token: first.refresh_token }),
    );

    expect(res.status).toBe(200);
    const next = await res.json();
    expect(next.access_token).not.toBe(first.access_token);
    expect(next.refresh_token).not.toBe(first.refresh_token);
    expect(db.rows.apiTokens).toHaveLength(1);
  });

  it("rejects an unsupported grant", async () => {
    const { app } = oauthApp({ oauthClients: [CLIENT] });
    const res = await app.request("/token", tokenForm({ grant_type: "password" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "unsupported_grant_type" });
  });
});

/* ---------------------------------------------------------------- billing */

const ORG_ID = TEST_ACTOR.orgId;
const WEBHOOK_SECRET = "whsec_test_secret";

const STRIPE_ENV = {
  STRIPE_SECRET_KEY: "sk_test_key",
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
};

function subscriptionEvent(id: string) {
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
        metadata: { orgId: ORG_ID },
        items: { object: "list", data: [{ id: "si_test", price: { id: "price_pro" } }] },
      },
    },
  });
}

function signed(payload: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(`${timestamp}.${payload}`).digest("hex");
  return {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": `t=${timestamp},v1=${signature}` },
    body: payload,
  };
}

function billingApp(env: Record<string, string | undefined>) {
  const db = fakeDb({
    orgs: [{ id: ORG_ID, name: "Acme", slug: "acme", planId: "free", trialEndsAt: null, createdAt: NOW }],
    plans: [{ id: "pro", name: "Pro", stripePriceId: "price_pro", priceMonthCents: 4900 }],
  });
  const { ctx } = fakeContext({ db, env, now: NOW });
  return { app: mount(ctx, billingRoutes(), TEST_ACTOR), db };
}

describe("billing", () => {
  it("turns every route but the webhook off when billing is not enabled", async () => {
    for (const env of [
      { OTA_MODE: "self" }, // self-hosted installs are not metered
      {}, // hosted, but no Stripe key configured
    ]) {
      const { app } = billingApp(env);

      for (const path of ["/checkout", "/portal"]) {
        const res = await app.request(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ orgId: ORG_ID, planId: "pro" }),
        });
        expect(res.status, path).toBe(400);
        const body = await res.json();
        expect(body.error.code).toBe("billing_disabled");
        expect(body.error.message).toContain("not enabled");
      }
    }
  });

  it("applies a webhook once, however many times Stripe redelivers it", async () => {
    const { app, db } = billingApp(STRIPE_ENV);
    const payload = subscriptionEvent("evt_repeat");

    const first = await app.request("/webhook", signed(payload));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ received: true });

    const second = await app.request("/webhook", signed(payload));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ received: true, duplicate: true });

    expect(db.calls.filter((call) => call === "update:orgs")).toHaveLength(1);
    expect(db.rows.orgs?.[0]?.planId).toBe("pro");
    expect(db.rows.stripeEvents).toHaveLength(1);
  });

  it("mirrors the subscription onto the org from the price, not the request", async () => {
    const { app, db } = billingApp(STRIPE_ENV);
    await app.request("/webhook", signed(subscriptionEvent("evt_mirror")));

    expect(db.rows.subscriptions?.[0]).toMatchObject({
      orgId: ORG_ID,
      stripeCustomerId: "cus_test",
      stripeSubscriptionId: "sub_test",
      status: "active",
      cancelAtPeriodEnd: false,
    });
  });

  it("refuses a payload that Stripe did not sign", async () => {
    const { app, db } = billingApp(STRIPE_ENV);
    const payload = subscriptionEvent("evt_forged");
    const res = await app.request("/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=deadbeef" },
      body: payload,
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_signature");
    expect(db.rows.stripeEvents).toHaveLength(0);
  });
});

/* ---------------------------------------------------------------- storage */

const PROJECT_ID = "0193a4c8-1111-7000-8000-000000000001";
const RELEASE_ID = "0193a4c8-2222-7000-8000-000000000002";
const KEY = `bundles/${PROJECT_ID}/${RELEASE_ID}.zip`;

function releaseRow(status: string) {
  return { id: RELEASE_ID, projectId: PROJECT_ID, storageKey: KEY, status, size: 3, sha256: "0".repeat(64) };
}

function storageApp(options: { status?: string; driver?: string } = {}) {
  const db = fakeDb({ releases: options.status ? [releaseRow(options.status)] : [] });
  const storage = fakeStorage(options.driver ?? "local");
  const { ctx } = fakeContext({ db, storage, now: NOW });
  return { app: mount(ctx, storageRoutes()), storage };
}

describe("storage passthrough", () => {
  it("accepts a bundle for a pending release and serves it back immutably", async () => {
    const { app, storage } = storageApp({ status: "pending" });
    const bytes = new Uint8Array([1, 2, 3]);

    const put = await app.request(`/${encodeURIComponent(KEY)}`, { method: "PUT", body: bytes });
    expect(put.status).toBe(201);
    expect(storage.objects.get(KEY)).toEqual(bytes);

    const get = await app.request(`/${encodeURIComponent(KEY)}`);
    expect(get.status).toBe(200);
    expect(get.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);
  });

  it("accepts the key as raw path segments too", async () => {
    const { app, storage } = storageApp({ status: "pending" });
    const res = await app.request(`/${KEY}`, { method: "PUT", body: new Uint8Array([9]) });
    expect(res.status).toBe(201);
    expect(storage.objects.has(KEY)).toBe(true);
  });

  it("refuses an upload for a release that is no longer pending", async () => {
    for (const status of ["active", "paused", "disabled"]) {
      const { app, storage } = storageApp({ status });
      const res = await app.request(`/${encodeURIComponent(KEY)}`, {
        method: "PUT",
        body: new Uint8Array([1]),
      });

      expect(res.status, status).toBe(409);
      expect((await res.json()).error.code).toBe("release_not_pending");
      expect(storage.objects.size).toBe(0);
    }
  });

  it("refuses an upload with no release behind it", async () => {
    const { app, storage } = storageApp();
    const res = await app.request(`/${encodeURIComponent(KEY)}`, { method: "PUT", body: new Uint8Array([1]) });
    expect(res.status).toBe(404);
    expect(storage.objects.size).toBe(0);
  });

  it("refuses a key that is not shaped like a bundle key", async () => {
    const { app, storage } = storageApp({ status: "pending" });

    for (const key of [
      "bundles/../../etc/passwd.zip",
      "bundles/%2e%2e/%2e%2e/secret.zip",
      `../${KEY}`,
      `bundles/${PROJECT_ID}/${RELEASE_ID}.zip/../../escape.zip`,
      `bundles/${PROJECT_ID}/${RELEASE_ID}.js`,
      `${KEY}extra`,
    ]) {
      const res = await app.request(`/${encodeURIComponent(key)}`, { method: "PUT", body: new Uint8Array([1]) });
      expect(res.status, key).toBe(400);
      expect((await res.json()).error.code).toBe("invalid_key");
    }
    expect(storage.objects.size).toBe(0);
  });

  it("stays dark when the driver can sign its own URLs", async () => {
    const { app } = storageApp({ status: "pending", driver: "s3" });
    const res = await app.request(`/${encodeURIComponent(KEY)}`, { method: "PUT", body: new Uint8Array([1]) });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("storage_passthrough_disabled");
  });
});
