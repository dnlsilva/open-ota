import type { ReactNode } from "react";

export function EmptyState({
  title,
  children,
  command,
  action,
}: {
  title: string;
  children?: ReactNode;
  /** A command the operator can copy to get out of the empty state. */
  command?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children ? <div className="empty-body">{children}</div> : null}
      {command ? <pre>{command}</pre> : null}
      {action ? <div style={{ marginTop: 14 }}>{action}</div> : null}
    </div>
  );
}

export function Loading({ label = "Loading", rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div className="stack-sm" role="status" aria-live="polite" style={{ padding: 14 }}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: 16, width: `${100 - i * 12}%` }} />
      ))}
    </div>
  );
}

export function ErrorState({
  title = "Something went wrong",
  message,
  onRetry,
  secondary,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
  secondary?: ReactNode;
}) {
  return (
    <div className="error-box" role="alert">
      <div className="stack-sm">
        <div className="error-title">{title}</div>
        <div>{message}</div>
        {onRetry || secondary ? (
          <div className="btn-group" style={{ marginTop: 4 }}>
            {onRetry ? (
              <button type="button" className="btn" onClick={onRetry}>
                Try again
              </button>
            ) : null}
            {secondary}
          </div>
        ) : null}
      </div>
    </div>
  );
}
