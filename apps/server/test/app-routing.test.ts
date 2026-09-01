/**
 * Exercises the fully assembled app, not one router at a time.
 *
 * The device routes and the admin routes share the /api/v1 prefix, and a
 * wildcard middleware in one of them silently applied to the other — every
 * admin request came back demanding a device app key. Each router passed its
 * own tests; only the mounted app showed it.
 */

import { APP_KEY_HEADER, uuidv7 } from "@open-ota/shared";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createApp } from "../src/app.js";
import { orgMembers, orgs, users } from "../src/db/schema.js";
import { issueToken } from "../src/services/auth.js";
import { hashPassword } from "../src/services/password.js";
import { createProject } from "../src/services/projects.js";
import { createTestHarness, type TestHarness } from "./helpers/testServer.js";

let h: TestHarness;
let app: ReturnType<typeof createApp>;
let token: string;
let appKey: string;
let projectId: string;

beforeAll(async () => {
  h = await createTestHarness();
  const userId = uuidv7();
  const orgId = uuidv7();
  await h.ctx.db.insert(users).values({
    id: userId,
    email: "route@test.local",
    passwordHash: await hashPassword("a-long-enough-password"),
    emailVerifiedAt: h.ctx.now(),
  });
  await h.ctx.db.insert(orgs).values({ id: orgId, name: "Routing", slug: "routing", planId: "free" });
  await h.ctx.db.insert(orgMembers).values({ orgId, userId, role: "owner" });

  const project = await createProject(h.ctx, { orgId, name: "Routed App", deepLinkScheme: "routed" });
  projectId = project.id;
  appKey = project.appKey;
  token = (await issueToken(h.ctx, { userId, orgId, name: "test", scopes: ["admin"] })).token;

  app = createApp(h.ctx);
});

afterAll(async () => {
  await h.close();
});

// A function, not a const: the token only exists after beforeAll runs.
const auth = () => ({ authorization: `Bearer ${token}` });

describe("mounted application", () => {
  it("serves admin routes without asking for a device app key", async () => {
    const res = await app.request("/api/v1/projects", { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects: unknown[] };
    expect(body.projects).toHaveLength(1);
  });

  it("still requires a token on admin routes", async () => {
    const res = await app.request("/api/v1/projects");
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthorized");
  });

  it("requires the app key on device routes, and not a bearer token", async () => {
    const query = `platform=ios&channel=production&runtime=fp_x&device=device-1`;
    expect((await app.request(`/api/v1/update-check?${query}`)).status).toBe(401);

    const ok = await app.request(`/api/v1/update-check?${query}`, {
      headers: { [APP_KEY_HEADER]: appKey },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ action: "none" });
  });

  it("keeps the public endpoints reachable with no credentials at all", async () => {
    for (const path of ["/healthz", "/api/v1/meta", "/api/v1/config", "/api/v1/plans"]) {
      expect((await app.request(path)).status, path).toBe(200);
    }
  });

  it("advertises the OAuth metadata an MCP client discovers", async () => {
    const res = await app.request("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code_challenge_methods_supported: string[] };
    expect(body.code_challenge_methods_supported).toContain("S256");
  });

  it("reaches project-scoped admin routes through the same prefix", async () => {
    const overview = await app.request(`/api/v1/projects/${projectId}/overview`, { headers: auth() });
    expect(overview.status).toBe(200);

    const distribution = await app.request(`/api/v1/projects/${projectId}/distribution`, { headers: auth() });
    expect(distribution.status).toBe(200);

    const releases = await app.request(`/api/v1/projects/${projectId}/releases`, { headers: auth() });
    expect(releases.status).toBe(200);
  });

  it("refuses a token from another organisation", async () => {
    const otherUser = uuidv7();
    const otherOrg = uuidv7();
    await h.ctx.db.insert(users).values({
      id: otherUser,
      email: "outsider@test.local",
      passwordHash: await hashPassword("another-long-password"),
    });
    await h.ctx.db.insert(orgs).values({ id: otherOrg, name: "Other", slug: "other", planId: "free" });
    const outsider = (await issueToken(h.ctx, { userId: otherUser, orgId: otherOrg, name: "t", scopes: ["admin"] }))
      .token;

    const res = await app.request(`/api/v1/projects/${projectId}/overview`, {
      headers: { authorization: `Bearer ${outsider}` },
    });
    // Not 403: an org must not learn that a project id exists at all.
    expect(res.status).toBe(404);
  });
});
