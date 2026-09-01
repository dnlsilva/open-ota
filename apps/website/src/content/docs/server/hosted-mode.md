---
title: Hosted mode
description: What OTA_MODE=hosted turns on — organisations, open signup, plan quotas and Stripe — and what stays off without it.
---

The same build runs a single-tenant install and a multi-tenant service.
`OTA_MODE=hosted` is the switch. `PUBLIC_URL` becomes mandatory with it,
because OAuth metadata and checkout redirects are built from it.

## Organisations, members and roles

Every resource hangs off an organisation: projects, releases, devices, API
tokens. A token carries one `orgId`, and every project route funnels through
`authorizeProject`, which refuses a project belonging to another organisation
with a 404 rather than a 403 — a token cannot learn that another org's project
exists.

Membership rows carry a role: `owner`, `admin` or `member`. Signup makes the
new user the `owner` of the organisation it creates. Billing routes call
`requireOrgRole`, which accepts `owner` and `admin`.

The self-hosted install uses the same schema. It just has one organisation, made
on first boot, and nothing ever asks which one you mean.

:::caution
There are no member-management endpoints yet. Roles exist in the schema and are
enforced for billing, but adding or removing a member is not exposed over the
API — the row has to be inserted directly.
:::

## Signup

In `hosted` mode signup is open and self-serve:

1. `POST /api/v1/auth/signup` with an email, a password of at least 10
   characters, and an optional organisation name.
2. The account is created unverified, its organisation is created on the `free`
   plan with a 14-day trial, and a verification mail goes out with a token that
   lasts 24 hours.
3. `POST /api/v1/auth/verify-email` stamps `emailVerifiedAt`.
4. `POST /api/v1/auth/login` refuses an unverified account until then.

An address that already exists gets the same "that address cannot be
registered" conflict as an invalid one, so the endpoint does not confirm which
addresses are registered.

In `self` mode the same endpoint accepts exactly one account. The first signup
is marked verified immediately — a fresh install has no way to receive mail —
and every later attempt is refused with "this server is self-hosted and already
has an account". The dashboard reads `signupEnabled` from `GET /api/v1/meta`
and hides the form.

## Plans and quotas

Three plans are seeded on boot by the Node entry. Each carries the same three
limits:

| Plan | Projects | Active devices | Storage | Price |
|---|---|---|---|---|
| free | 1 | 1,000 | 1 GB | 0 |
| pro | 5 | 50,000 | 20 GB | 49.00/month |
| scale | 50 | 1,000,000 | 200 GB | 249.00/month |

Active devices are counted over a 30-day window: rows in `devices` whose
`lastSeenAt` falls inside it. Storage is the sum of `releases.size` across the
organisation. `GET /api/v1/orgs/:orgId/usage` returns all three against their
limits plus an `overQuota` flag, and `GET /api/v1/plans` is public because
prices are not a secret.

In `self` mode `getPlanFor` returns a synthetic self-hosted plan whose limits
are `Number.MAX_SAFE_INTEGER`, and both quota checks return before doing any
work.

## The product rule

Exceeding a quota blocks new publishes. It never blocks update-check or bundle
downloads.

A customer's end users must not have their app break because of a billing state
they cannot see. So `assertCanPublish` runs on `prepare-upload` and refuses
when the organisation is already over its device limit, or when the incoming
bundle would take it past its storage limit — and the error says so plainly:
"existing apps keep receiving updates — upgrade to publish new ones".
`assertCanCreateProject` does the same for the project count. Nothing on the
Device API consults a plan at all.

## Stripe

Billing turns on only when `OTA_MODE=hosted` and `STRIPE_SECRET_KEY` is set.
Everything below is off otherwise.

- **Checkout** — `POST /api/v1/billing/checkout` with an org and a plan creates
  a subscription-mode session. The org id rides along in
  `client_reference_id`, `metadata` and `subscription_data.metadata`, because
  without it the webhook has no way back to the organisation that paid. A plan
  with no `stripePriceId` is not purchasable.
- **Portal** — `POST /api/v1/billing/portal` opens the Stripe customer portal
  for the org's existing customer, returning to `STRIPE_PORTAL_RETURN_URL`.
- **Webhooks** — `POST /api/v1/billing/webhook` is public and verifies the
  signature over the exact received bytes, which are never re-serialised. The
  event id is then claimed in `stripe_events` with an insert that does nothing
  on conflict; if the row already existed the handler returns
  `{received: true, duplicate: true}` without touching state. Redelivery is
  therefore free. Handled events: `checkout.session.completed`,
  `customer.subscription.created`, `.updated`, `.deleted`, and
  `invoice.payment_failed`.

`subscriptions` is a mirror of Stripe and never leads it. The webhook and
`reconcileSubscriptions` are its only writers, and `org.planId` always comes
from the price actually on the subscription — never from what a client asked
for. A cancelled or expired subscription drops the org back to `free`.

:::caution
`reconcileSubscriptions` exists and re-reads every mirrored subscription from
Stripe, but nothing schedules it. Call it from a cron entry or an admin action
if you want a webhook that never arrived to stop mattering.
:::

## What stays off in self mode

- Billing routes answer 400 with `billing_disabled`.
- Quotas are unlimited and never checked.
- Signup closes after the first account, which is verified immediately.
- Organisations get no trial period.
- `GET /api/v1/meta` reports `hosted: false`, `billingEnabled: false` and
  `signupEnabled: false`, and the dashboard adapts.

Remote MCP is not part of this split. `/mcp` and the OAuth endpoints are
available on every install regardless of mode — see
[connect an agent](/mcp/connect/).
