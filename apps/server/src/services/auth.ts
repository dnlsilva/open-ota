/**
 * Bearer tokens everywhere — dashboard, `ota console`, CLI, MCP and CI all use
 * the same mechanism. A cookie would break the console running locally against
 * a remote API, and would mean two auth paths to keep correct. docs/API.md §1.
 */

import { generateApiToken, hashToken, uuidv7 } from "@open-ota/shared";
import { and, eq, sql } from "drizzle-orm";
import { apiTokens, emailVerifications, orgMembers, orgs, projects, users } from "../db/schema.js";
import type { Actor, AppContext } from "./context.js";
import { ApiError } from "./errors.js";
import { hashPassword, needsRehash, verifyPassword } from "./password.js";

const TOKEN_TTL_DAYS = 90;
const VERIFICATION_TTL_HOURS = 24;

export async function signup(
  ctx: AppContext,
  input: { email: string; password: string; orgName?: string },
): Promise<{ userId: string; verificationRequired: boolean }> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw ApiError.badRequest("invalid_email", "That does not look like an email address");
  }
  if (input.password.length < 10) {
    throw ApiError.badRequest("weak_password", "Use at least 10 characters");
  }

  const existing = await ctx.db.query.users.findFirst({ where: eq(users.email, email) });
  if (existing) {
    // Do not confirm which addresses are registered.
    throw ApiError.conflict("signup_failed", "That address cannot be registered");
  }

  if (!ctx.config.hosted) {
    const [{ count } = { count: 0 }] = await ctx.db.select({ count: sql<number>`count(*)::int` }).from(users);
    if (count > 0) {
      throw ApiError.forbidden("This server is self-hosted and already has an account");
    }
  }

  const userId = uuidv7();
  // Self-hosted installs have no way to receive mail on day one, so the single
  // admin is verified immediately; hosted signups must confirm.
  const verificationRequired = ctx.config.hosted;

  await ctx.db.insert(users).values({
    id: userId,
    email,
    passwordHash: await hashPassword(input.password),
    emailVerifiedAt: verificationRequired ? null : ctx.now(),
  });

  await createOrg(ctx, userId, input.orgName ?? email.split("@")[0]!);

  if (verificationRequired) await sendVerificationEmail(ctx, userId, email);

  return { userId, verificationRequired };
}

export async function createOrg(ctx: AppContext, userId: string, name: string) {
  const orgId = uuidv7();
  const slug = await uniqueSlug(ctx, name);
  const trialDays = ctx.config.hosted ? 14 : 0;

  const [org] = await ctx.db
    .insert(orgs)
    .values({
      id: orgId,
      name,
      slug,
      planId: "free",
      trialEndsAt: trialDays ? new Date(ctx.now().getTime() + trialDays * 86_400_000) : null,
    })
    .returning();

  await ctx.db.insert(orgMembers).values({ orgId, userId, role: "owner" });
  return org!;
}

export async function sendVerificationEmail(ctx: AppContext, userId: string, email: string) {
  const token = generateApiToken("otav");
  await ctx.db.insert(emailVerifications).values({
    tokenHash: await hashToken(token),
    userId,
    expiresAt: new Date(ctx.now().getTime() + VERIFICATION_TTL_HOURS * 3_600_000),
  });

  const link = `${ctx.config.publicUrl}/verify?token=${token}`;
  await ctx.email.send({
    to: email,
    subject: "Confirm your Open OTA account",
    text: `Confirm your address to finish setting up your account:\n\n${link}\n\nThe link is valid for ${VERIFICATION_TTL_HOURS} hours.`,
  });
}

export async function verifyEmail(ctx: AppContext, token: string): Promise<void> {
  const tokenHash = await hashToken(token);
  const record = await ctx.db.query.emailVerifications.findFirst({
    where: eq(emailVerifications.tokenHash, tokenHash),
  });
  if (!record || record.expiresAt < ctx.now()) {
    throw ApiError.badRequest("invalid_verification", "That confirmation link is expired or invalid");
  }

  await ctx.db.update(users).set({ emailVerifiedAt: ctx.now() }).where(eq(users.id, record.userId));
  await ctx.db.delete(emailVerifications).where(eq(emailVerifications.tokenHash, tokenHash));
}

export async function login(
  ctx: AppContext,
  input: { email: string; password: string; tokenName?: string },
) {
  const email = input.email.trim().toLowerCase();
  const user = await ctx.db.query.users.findFirst({ where: eq(users.email, email) });

  // Always spend the work factor, so a missing account is not faster to probe.
  const stored = user?.passwordHash ?? (await hashPassword("placeholder-for-timing"));
  const ok = await verifyPassword(input.password, stored);
  if (!user || !ok) throw ApiError.unauthorized("Wrong email or password");

  if (ctx.config.hosted && !user.emailVerifiedAt) {
    throw ApiError.forbidden("Confirm your email address before signing in");
  }

  if (needsRehash(user.passwordHash)) {
    await ctx.db
      .update(users)
      .set({ passwordHash: await hashPassword(input.password) })
      .where(eq(users.id, user.id));
  }

  const memberships = await ctx.db
    .select({ org: orgs })
    .from(orgMembers)
    .innerJoin(orgs, eq(orgs.id, orgMembers.orgId))
    .where(eq(orgMembers.userId, user.id));

  const org = memberships[0]?.org;
  if (!org) throw ApiError.forbidden("This account is not a member of any organisation");

  const { token } = await issueToken(ctx, {
    userId: user.id,
    orgId: org.id,
    name: input.tokenName ?? "session",
    scopes: ["admin"],
    expiresInDays: TOKEN_TTL_DAYS,
  });

  return {
    token,
    user: { id: user.id, email: user.email },
    orgs: memberships.map((m) => ({
      id: m.org.id,
      name: m.org.name,
      slug: m.org.slug,
      planId: m.org.planId,
      trialEndsAt: m.org.trialEndsAt?.toISOString() ?? null,
      createdAt: m.org.createdAt.toISOString(),
    })),
  };
}

export async function issueToken(
  ctx: AppContext,
  input: {
    userId: string;
    orgId: string;
    name: string;
    scopes: string[];
    projectId?: string | null;
    kind?: "manual" | "oauth";
    expiresInDays?: number;
  },
) {
  const token = generateApiToken();
  const id = uuidv7();
  await ctx.db.insert(apiTokens).values({
    id,
    userId: input.userId,
    orgId: input.orgId,
    projectId: input.projectId ?? null,
    name: input.name,
    tokenHash: await hashToken(token),
    scopes: input.scopes,
    kind: input.kind ?? "manual",
    expiresAt: input.expiresInDays
      ? new Date(ctx.now().getTime() + input.expiresInDays * 86_400_000)
      : null,
  });
  return { id, token };
}

export async function authenticate(ctx: AppContext, bearer: string | undefined): Promise<Actor> {
  const token = bearer?.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw ApiError.unauthorized();

  const row = await ctx.db.query.apiTokens.findFirst({
    where: eq(apiTokens.tokenHash, await hashToken(token)),
  });
  if (!row) throw ApiError.unauthorized("That token is not valid");
  if (row.expiresAt && row.expiresAt < ctx.now()) {
    throw ApiError.unauthorized("That token has expired — sign in again");
  }

  // Cheap enough to keep honest, and it powers "last used" in settings.
  const lastUsed = row.lastUsedAt?.getTime() ?? 0;
  if (ctx.now().getTime() - lastUsed > 60_000) {
    await ctx.db.update(apiTokens).set({ lastUsedAt: ctx.now() }).where(eq(apiTokens.id, row.id));
  }

  return {
    userId: row.userId,
    orgId: row.orgId,
    tokenId: row.id,
    scopes: row.scopes,
    projectId: row.projectId,
  };
}

/** Every project route funnels through here — a token never reaches another org. */
export async function authorizeProject(ctx: AppContext, actor: Actor, projectId: string) {
  const project = await ctx.db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) throw ApiError.notFound("project_not_found", "No project with that id");
  if (project.orgId !== actor.orgId) throw ApiError.notFound("project_not_found", "No project with that id");
  if (actor.projectId && actor.projectId !== projectId) {
    throw ApiError.forbidden("This token is scoped to a different project");
  }
  return project;
}

export function requireAdminScope(actor: Actor): void {
  if (!actor.scopes.includes("admin")) {
    throw ApiError.forbidden("This token is read-only");
  }
}

export async function requireOrgRole(
  ctx: AppContext,
  actor: Actor,
  orgId: string,
  roles: string[] = ["owner", "admin"],
) {
  const membership = await ctx.db.query.orgMembers.findFirst({
    where: and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, actor.userId)),
  });
  if (!membership || !roles.includes(membership.role)) {
    throw ApiError.forbidden("You do not have permission in this organisation");
  }
  return membership;
}

async function uniqueSlug(ctx: AppContext, name: string): Promise<string> {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "org";

  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const taken = await ctx.db.query.orgs.findFirst({ where: eq(orgs.slug, candidate) });
    if (!taken) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}
