import type { ReactNode } from "react";
import type { ReleaseStatus, RollbackReason } from "@open-ota/shared";

export type Tone = "neutral" | "healthy" | "warning" | "critical" | "accent";

/**
 * Operational thresholds. A release that crashes on 1 device in 100 is already
 * worth looking at, and 1 in 20 is an incident — so the bands are tight.
 */
export function rollbackTone(rate: number | null | undefined): Tone {
  if (rate === null || rate === undefined) return "neutral";
  if (rate >= 5) return "critical";
  if (rate >= 1) return "warning";
  return "healthy";
}

export function successTone(rate: number | null | undefined): Tone {
  if (rate === null || rate === undefined) return "neutral";
  if (rate < 90) return "critical";
  if (rate < 98) return "warning";
  return "healthy";
}

export function statusTone(status: ReleaseStatus): Tone {
  switch (status) {
    case "active":
      return "healthy";
    case "paused":
      return "warning";
    case "disabled":
      return "critical";
    default:
      return "neutral";
  }
}

const STATUS_TITLE: Record<ReleaseStatus, string> = {
  pending: "Upload not confirmed yet — not offered to any device",
  active: "Offered to devices inside the rollout",
  paused: "Not offered to new devices; devices that have it keep it",
  disabled: "Withdrawn — devices converge to the previous release or the embedded bundle",
};

export function Pill({
  tone = "neutral",
  children,
  title,
  dot = true,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
  dot?: boolean;
}) {
  return (
    <span className={`pill tone-${tone}${dot ? "" : " no-dot"}`} title={title}>
      {children}
    </span>
  );
}

export function StatusPill({ status }: { status: ReleaseStatus }) {
  return (
    <Pill tone={statusTone(status)} title={STATUS_TITLE[status]}>
      {status}
    </Pill>
  );
}

const REASON_TONE: Record<RollbackReason, Tone> = {
  crash: "critical",
  verifyFailed: "critical",
  server: "neutral",
  manual: "neutral",
};

const REASON_LABEL: Record<RollbackReason, string> = {
  crash: "crash",
  verifyFailed: "verify failed",
  server: "server",
  manual: "manual",
};

export function ReasonPill({ reason }: { reason: RollbackReason }) {
  return <Pill tone={REASON_TONE[reason]}>{REASON_LABEL[reason]}</Pill>;
}

export function Stat({
  label,
  value,
  sub,
  tone = "neutral",
  title,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  title?: string;
}) {
  return (
    <div className={`stat tone-${tone}`} title={title}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {sub ? <span className="stat-sub">{sub}</span> : null}
    </div>
  );
}
