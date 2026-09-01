import type { ReleaseFunnel } from "@open-ota/shared";
import { formatNumber, formatRate } from "../lib/format";
import { EmptyState } from "./EmptyState";

const STEPS = [
  { key: "downloads", name: "Downloaded", hint: "Bundle fetched from the CDN" },
  { key: "installs", name: "Installed", hint: "Unpacked and staged for the next launch" },
  { key: "ready", name: "Ready", hint: "Launched and confirmed healthy by notifyAppReady()" },
] as const;

export function Funnel({ funnel }: { funnel: ReleaseFunnel }) {
  const base = funnel.downloads;

  if (base === 0 && funnel.installs === 0 && funnel.ready === 0) {
    return (
      <EmptyState title="No devices have taken this release yet">
        Counters land here as devices download, install and confirm the update. A paused or 0%
        release will stay empty by design.
      </EmptyState>
    );
  }

  return (
    <div className="stack">
      <div className="funnel">
        {STEPS.map((step, index) => {
          const value = funnel[step.key];
          const previous = index === 0 ? value : funnel[STEPS[index - 1]!.key];
          const width = base > 0 ? Math.min(100, (value / base) * 100) : 0;
          const stepRate = previous > 0 ? value / previous : null;
          return (
            <div className="funnel-step" key={step.key}>
              <span className="funnel-name">{step.name}</span>
              <div
                className="funnel-track"
                title={`${step.hint}${
                  index > 0 && stepRate !== null ? ` — ${formatRate(stepRate)} of the previous step` : ""
                }`}
              >
                <div
                  className={`funnel-fill${step.key === "ready" ? " tone-healthy" : ""}`}
                  style={{ width: `${width}%` }}
                />
              </div>
              <span className="funnel-value">
                {formatNumber(value)}
                {index > 0 ? <span className="pct">{base > 0 ? formatRate(value / base) : "—"}</span> : null}
              </span>
            </div>
          );
        })}
      </div>

      <div className="leaks">
        <div className={`leak${funnel.failed > 0 ? " tone-warning" : ""}`}>
          <div className="leak-value">{formatNumber(funnel.failed)}</div>
          <div className="leak-label" title="Signature or hash rejected, or a crash before the first ready">
            Failed
          </div>
        </div>
        <div className={`leak${funnel.rollbacks > 0 ? " tone-critical" : ""}`}>
          <div className="leak-value">{formatNumber(funnel.rollbacks)}</div>
          <div className="leak-label" title="Devices that reverted to the previous release or the embedded bundle">
            Rolled back
          </div>
        </div>
      </div>
    </div>
  );
}
