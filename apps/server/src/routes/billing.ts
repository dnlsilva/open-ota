/**
 * Stripe. Hosted only: a self-hosted install is not metered, so every route
 * except the webhook answers 400 when config.billingEnabled is false.
 *
 * `subscriptions` mirrors Stripe and never leads it — the webhook and
 * reconcileSubscriptions are the only writers, and org.planId always comes from
 * the price actually on the subscription, never from what the client asked for.
 * docs/API.md §3, docs/ARCHITECTURE.md §7.
 */

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import Stripe from "stripe";
import { z } from "zod";
import type { AppEnv } from "../app.js";
import { orgs, plans, stripeEvents, subscriptions } from "../db/schema.js";
import { requireOrgRole } from "../services/auth.js";
import type { AppContext } from "../services/context.js";
import { ApiError } from "../services/errors.js";

type SubscriptionPatch = Partial<typeof subscriptions.$inferInsert>;

export function billingRoutes() {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    // Stripe calls the webhook with no actor, and it must keep answering even
    // where checkout is switched off, so it runs its own checks.
    if (c.req.path.endsWith("/webhook")) return next();
    if (!c.get("ctx").config.billingEnabled) throw billingDisabled();
    await next();
  });

  app.post("/checkout", async (c) => {
    const ctx = c.get("ctx");
    const { orgId, planId } = z
      .object({ orgId: z.string().uuid(), planId: z.string().min(1) })
      .parse(await c.req.json());
    await requireOrgRole(ctx, c.get("actor"), orgId);

    const plan = await ctx.db.query.plans.findFirst({ where: eq(plans.id, planId) });
    if (!plan) throw ApiError.notFound("plan_not_found", `No plan called "${planId}"`);
    if (!plan.stripePriceId) {
      throw ApiError.badRequest("plan_not_purchasable", `The ${plan.name} plan has no Stripe price configured`);
    }

    const stripe = stripeClient(ctx);
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: await ensureCustomer(ctx, stripe, orgId),
      line_items: [{ price: plan.stripePriceId, quantity: 1 }],
      // Without these the webhook has no way back to the org that paid.
      client_reference_id: orgId,
      metadata: { orgId },
      subscription_data: { metadata: { orgId } },
      success_url: `${ctx.config.publicUrl}/billing?checkout=done`,
      cancel_url: `${ctx.config.publicUrl}/billing?checkout=cancelled`,
    });

    if (!session.url) throw ApiError.badRequest("checkout_failed", "Stripe returned no checkout URL");
    return c.json({ url: session.url });
  });

  app.post("/portal", async (c) => {
    const ctx = c.get("ctx");
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(await c.req.json());
    await requireOrgRole(ctx, c.get("actor"), orgId);

    const row = await ctx.db.query.subscriptions.findFirst({ where: eq(subscriptions.orgId, orgId) });
    if (!row?.stripeCustomerId) {
      throw ApiError.badRequest("no_customer", "This organisation has never been through checkout");
    }

    const session = await stripeClient(ctx).billingPortal.sessions.create({
      customer: row.stripeCustomerId,
      return_url: ctx.config.STRIPE_PORTAL_RETURN_URL ?? `${ctx.config.publicUrl}/billing`,
    });
    return c.json({ url: session.url });
  });

  app.post("/webhook", async (c) => {
    const ctx = c.get("ctx");
    const secret = ctx.config.STRIPE_WEBHOOK_SECRET;
    if (!secret || !ctx.config.STRIPE_SECRET_KEY) throw billingDisabled();

    const signature = c.req.header("stripe-signature");
    if (!signature) throw ApiError.badRequest("missing_signature", "Missing stripe-signature header");

    // The signature covers these exact bytes, so the body is never re-serialised.
    const raw = await c.req.text();

    let event: Stripe.Event;
    try {
      event = await stripeClient(ctx).webhooks.constructEventAsync(
        raw,
        signature,
        secret,
        undefined,
        Stripe.createSubtleCryptoProvider(),
      );
    } catch {
      throw ApiError.badRequest("invalid_signature", "That payload was not signed by Stripe");
    }

    // Claim the id before applying anything: a redelivery finds the row and
    // returns 200 without touching state.
    const claimed = await ctx.db
      .insert(stripeEvents)
      .values({ id: event.id })
      .onConflictDoNothing()
      .returning();
    if (claimed.length === 0) return c.json({ received: true, duplicate: true });

    await applyEvent(ctx, event);
    return c.json({ received: true });
  });

  return app;
}

/**
 * Re-reads every mirrored subscription from Stripe and re-applies it, so a
 * webhook that never arrived stops mattering. Not scheduled yet — call it from
 * a cron entry or an admin action.
 */
export async function reconcileSubscriptions(ctx: AppContext): Promise<{ checked: number }> {
  if (!ctx.config.billingEnabled) return { checked: 0 };

  const stripe = stripeClient(ctx);
  const rows = await ctx.db.select().from(subscriptions);

  let checked = 0;
  for (const row of rows) {
    if (!row.stripeSubscriptionId) continue;
    const remote = await stripe.subscriptions.retrieve(row.stripeSubscriptionId).catch(() => null);
    if (!remote) continue;
    await applySubscription(ctx, remote, row.orgId);
    checked++;
  }
  return { checked };
}

/* ----------------------------------------------------------------- events */

async function applyEvent(ctx: AppContext, event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const orgId = session.metadata?.orgId ?? session.client_reference_id;
      const customerId = idOf(session.customer);
      if (!orgId || !customerId) return;

      await mirror(ctx, orgId, { stripeCustomerId: customerId });

      // The session says who paid; only the subscription says for what.
      const subscriptionId = idOf(session.subscription);
      if (!subscriptionId) return;
      const sub = await stripeClient(ctx).subscriptions.retrieve(subscriptionId);
      await applySubscription(ctx, sub, orgId);
      return;
    }

    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await applySubscription(ctx, event.data.object);
      return;

    case "invoice.payment_failed": {
      const orgId = await orgIdForCustomer(ctx, idOf(event.data.object.customer));
      if (orgId) await mirror(ctx, orgId, { status: "past_due" });
      return;
    }

    default:
      return;
  }
}

async function applySubscription(
  ctx: AppContext,
  sub: Stripe.Subscription,
  knownOrgId?: string,
): Promise<void> {
  const orgId =
    knownOrgId ?? sub.metadata?.orgId ?? (await orgIdForCustomer(ctx, idOf(sub.customer)));
  if (!orgId) return;

  const ended = sub.status === "canceled" || sub.status === "incomplete_expired";

  await mirror(ctx, orgId, {
    stripeCustomerId: idOf(sub.customer),
    stripeSubscriptionId: sub.id,
    status: sub.status,
    currentPeriodEnd: new Date(sub.current_period_end * 1000),
    cancelAtPeriodEnd: sub.cancel_at_period_end,
  });

  const priceId = sub.items.data[0]?.price.id;
  const plan =
    ended || !priceId
      ? undefined
      : await ctx.db.query.plans.findFirst({ where: eq(plans.stripePriceId, priceId) });

  const planId = ended ? "free" : plan?.id;
  if (planId) await ctx.db.update(orgs).set({ planId }).where(eq(orgs.id, orgId));
}

async function mirror(ctx: AppContext, orgId: string, patch: SubscriptionPatch): Promise<void> {
  const set = { ...patch, updatedAt: ctx.now() };
  await ctx.db
    .insert(subscriptions)
    .values({ orgId, ...set })
    .onConflictDoUpdate({ target: subscriptions.orgId, set });
}

async function orgIdForCustomer(ctx: AppContext, customerId: string | null): Promise<string | null> {
  if (!customerId) return null;
  const row = await ctx.db.query.subscriptions.findFirst({
    where: eq(subscriptions.stripeCustomerId, customerId),
  });
  return row?.orgId ?? null;
}

/* ------------------------------------------------------------------ stripe */

function stripeClient(ctx: AppContext): Stripe {
  const key = ctx.config.STRIPE_SECRET_KEY;
  if (!key) throw billingDisabled();
  // fetch, not the Node http agent: the same client has to run on Workers and
  // in a Supabase Edge Function.
  return new Stripe(key, { httpClient: Stripe.createFetchHttpClient() });
}

async function ensureCustomer(ctx: AppContext, stripe: Stripe, orgId: string): Promise<string> {
  const existing = await ctx.db.query.subscriptions.findFirst({
    where: eq(subscriptions.orgId, orgId),
  });
  if (existing?.stripeCustomerId) return existing.stripeCustomerId;

  const org = await ctx.db.query.orgs.findFirst({ where: eq(orgs.id, orgId) });
  const customer = await stripe.customers.create({ name: org?.name, metadata: { orgId } });
  await mirror(ctx, orgId, { stripeCustomerId: customer.id });
  return customer.id;
}

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

function billingDisabled(): ApiError {
  return ApiError.badRequest(
    "billing_disabled",
    "Billing is not enabled on this deployment — self-hosted installs are not metered",
  );
}
