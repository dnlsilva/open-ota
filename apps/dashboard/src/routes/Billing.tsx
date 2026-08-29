import { Link, useParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import type { Plan, Subscription } from "@open-ota/shared";
import { useAuth } from "../api/auth";
import { client, errorMessage, useOrgUsage, usePlans, useServerConfig } from "../api/client";
import { EmptyState, ErrorState, Loading } from "../components/EmptyState";
import { Page } from "../components/Layout";
import { Pill, Stat } from "../components/StatPill";
import type { Tone } from "../components/StatPill";
import { useToast } from "../components/Toast";
import { formatDateTime, formatNumber } from "../lib/format";

const SUBSCRIPTION_TONE: Record<Subscription["status"], Tone> = {
  none: "neutral",
  trialing: "accent",
  active: "healthy",
  past_due: "warning",
  canceled: "critical",
};

function quotaTone(used: number, limit: number): Tone {
  if (limit <= 0) return "neutral";
  const ratio = used / limit;
  if (ratio >= 1) return "critical";
  if (ratio >= 0.8) return "warning";
  return "neutral";
}

export function Billing() {
  const { orgId } = useParams();
  const { orgs } = useAuth();
  const config = useServerConfig();
  const usage = useOrgUsage(orgId);
  const billingEnabled = config.data?.billingEnabled ?? false;
  const plans = usePlans(billingEnabled);
  const toast = useToast();
  const org = orgs.find((candidate) => candidate.id === orgId);

  const checkout = useMutation({
    mutationFn: (planId: string) => client.createCheckout(orgId as string, planId),
    onSuccess: (result) => window.location.assign(result.url),
    onError: (error) => toast(errorMessage(error), "critical"),
  });

  const portal = useMutation({
    mutationFn: () => client.createBillingPortal(orgId as string),
    onSuccess: (result) => window.location.assign(result.url),
    onError: (error) => toast(errorMessage(error), "critical"),
  });

  return (
    <Page>
      <div className="page-head">
        <div>
          <div className="crumbs small">
            <Link to="/">Projects</Link>
            <span className="sep">/</span>
            <strong>{org?.name ?? "Organization"}</strong>
          </div>
          <h1>Plan and usage</h1>
        </div>
        <span className="spacer" />
        {billingEnabled ? (
          <button type="button" className="btn" disabled={portal.isPending} onClick={() => portal.mutate()}>
            {portal.isPending ? "Opening…" : "Manage billing"}
          </button>
        ) : null}
      </div>

      <div className="stack">
        {!billingEnabled ? (
          <div className="notice">
            <strong>Self-hosted deployment — billing is off.</strong> Quotas below come from the plan
            configured on this server; there is nothing to pay and no checkout to run.
          </div>
        ) : null}

        {usage.isPending ? <Loading label="Loading usage" rows={4} /> : null}

        {usage.isError ? (
          <ErrorState
            title="Could not load usage"
            message={errorMessage(usage.error)}
            onRetry={() => void usage.refetch()}
          />
        ) : null}

        {usage.data ? (
          <>
            <section className="card">
              <div className="card-head">
                <h2>Subscription</h2>
                <span className="spacer" />
                <Pill tone={SUBSCRIPTION_TONE[usage.data.subscription.status]}>
                  {usage.data.subscription.status.replace("_", " ")}
                </Pill>
              </div>
              <div className="card-body">
                <div className="grid grid-stats">
                  <Stat label="Plan" value={usage.data.subscription.planId || org?.planId || "free"} />
                  <Stat
                    label="Renews"
                    value={
                      usage.data.subscription.currentPeriodEnd
                        ? formatDateTime(usage.data.subscription.currentPeriodEnd)
                        : "—"
                    }
                    sub={usage.data.subscription.cancelAtPeriodEnd ? "Cancels at period end" : undefined}
                    tone={usage.data.subscription.cancelAtPeriodEnd ? "warning" : "neutral"}
                  />
                  <Stat
                    label="Quota"
                    value={usage.data.usage.overQuota ? "Over limit" : "Within limits"}
                    tone={usage.data.usage.overQuota ? "critical" : "healthy"}
                  />
                </div>
              </div>
            </section>

            <section className="card">
              <div className="card-head">
                <h2>Usage</h2>
                <span className="spacer" />
                <span className="small muted">Active devices counted over the last 30 days</span>
              </div>
              <div className="card-body stack">
                <UsageBar
                  label="Projects"
                  used={usage.data.usage.projects.used}
                  limit={usage.data.usage.projects.limit}
                />
                <UsageBar
                  label="Active devices"
                  used={usage.data.usage.activeDevices.used}
                  limit={usage.data.usage.activeDevices.limit}
                />
                <UsageBar
                  label="Bundle storage"
                  used={usage.data.usage.storageGb.used}
                  limit={usage.data.usage.storageGb.limit}
                  unit="GB"
                />

                <div className={usage.data.usage.overQuota ? "notice tone-warning" : "notice"}>
                  Going over quota blocks new publishes. It never blocks update checks or bundle
                  downloads — apps already in production keep updating whatever the billing state.
                </div>
              </div>
            </section>

            {billingEnabled ? (
              <section className="card">
                <div className="card-head">
                  <h2>Plans</h2>
                </div>
                <div className="card-body">
                  {plans.isPending ? (
                    <Loading label="Loading plans" />
                  ) : plans.data && plans.data.length > 0 ? (
                    <div className="grid grid-3">
                      {plans.data.map((plan) => (
                        <PlanCard
                          key={plan.id}
                          plan={plan}
                          current={plan.id === (usage.data?.subscription.planId ?? org?.planId)}
                          busy={checkout.isPending}
                          onSelect={() => checkout.mutate(plan.id)}
                        />
                      ))}
                    </div>
                  ) : (
                    <EmptyState
                      title="No plan catalogue available"
                      action={
                        <button
                          type="button"
                          className="btn"
                          disabled={portal.isPending}
                          onClick={() => portal.mutate()}
                        >
                          Open the billing portal
                        </button>
                      }
                    >
                      This server did not return a plan list. Subscriptions can still be changed from the
                      billing portal.
                    </EmptyState>
                  )}
                </div>
              </section>
            ) : null}
          </>
        ) : null}
      </div>
    </Page>
  );
}

function UsageBar({
  label,
  used,
  limit,
  unit,
}: {
  label: string;
  used: number;
  limit: number;
  unit?: string;
}) {
  const unlimited = limit <= 0;
  const percent = unlimited ? 0 : Math.min(100, (used / limit) * 100);
  const tone = quotaTone(used, limit);
  const suffix = unit ? ` ${unit}` : "";

  return (
    <div className="stack-sm">
      <div className="row">
        <strong>{label}</strong>
        <span className="spacer" />
        <span className="num muted">
          {formatNumber(used)}
          {suffix} {unlimited ? "used (no limit)" : `of ${formatNumber(limit)}${suffix}`}
        </span>
      </div>
      {unlimited ? null : (
        <div
          className="meter"
          role="meter"
          aria-valuenow={used}
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-label={`${label}: ${used} of ${limit}`}
        >
          <div className={`meter-fill tone-${tone}`} style={{ width: `${percent}%` }} />
        </div>
      )}
    </div>
  );
}

function PlanCard({
  plan,
  current,
  busy,
  onSelect,
}: {
  plan: Plan;
  current: boolean;
  busy: boolean;
  onSelect: () => void;
}) {
  return (
    <div className={`plan-card${current ? " current" : ""}`}>
      <div className="row">
        <strong>{plan.name}</strong>
        {current ? (
          <Pill tone="accent" dot={false}>
            current
          </Pill>
        ) : null}
      </div>
      <div className="plan-price">
        {plan.priceMonthCents === 0 ? "Free" : `$${(plan.priceMonthCents / 100).toFixed(0)}`}
        {plan.priceMonthCents > 0 ? <span className="small muted"> /month</span> : null}
      </div>
      <ul>
        <li>{formatNumber(plan.maxProjects)} projects</li>
        <li>{formatNumber(plan.maxActiveDevices)} active devices</li>
        <li>{formatNumber(plan.maxStorageGb)} GB of bundles</li>
      </ul>
      <button
        type="button"
        className={current ? "btn" : "btn btn-primary"}
        disabled={current || busy}
        onClick={onSelect}
      >
        {current ? "Current plan" : `Upgrade to ${plan.name}`}
      </button>
    </div>
  );
}
