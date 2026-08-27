import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.js";
import { orgMembers, orgs, users } from "../db/schema.js";
import { authenticate, login, signup, verifyEmail } from "../services/auth.js";
import { ApiError } from "../services/errors.js";

export function authRoutes() {
  const app = new Hono<AppEnv>();

  app.post("/signup", async (c) => {
    const ctx = c.get("ctx");
    const body = z
      .object({
        email: z.string().email(),
        password: z.string().min(10).max(200),
        orgName: z.string().min(1).max(80).optional(),
      })
      .parse(await c.req.json());

    return c.json(await signup(ctx, body), 201);
  });

  app.post("/verify-email", async (c) => {
    const { token } = z.object({ token: z.string().min(8) }).parse(await c.req.json());
    await verifyEmail(c.get("ctx"), token);
    return c.json({ verified: true });
  });

  app.post("/login", async (c) => {
    const body = z
      .object({ email: z.string().email(), password: z.string().min(1), tokenName: z.string().max(60).optional() })
      .parse(await c.req.json());

    return c.json(await login(c.get("ctx"), body));
  });

  app.get("/me", async (c) => {
    const ctx = c.get("ctx");
    const actor = await authenticate(ctx, c.req.header("authorization"));

    const user = await ctx.db.query.users.findFirst({ where: eq(users.id, actor.userId) });
    if (!user) throw ApiError.unauthorized();

    const memberships = await ctx.db
      .select({ org: orgs, role: orgMembers.role })
      .from(orgMembers)
      .innerJoin(orgs, eq(orgs.id, orgMembers.orgId))
      .where(eq(orgMembers.userId, user.id));

    return c.json({
      user: { id: user.id, email: user.email },
      orgs: memberships.map((m) => ({
        id: m.org.id,
        name: m.org.name,
        slug: m.org.slug,
        planId: m.org.planId,
        trialEndsAt: m.org.trialEndsAt?.toISOString() ?? null,
        createdAt: m.org.createdAt.toISOString(),
      })),
    });
  });

  return app;
}
