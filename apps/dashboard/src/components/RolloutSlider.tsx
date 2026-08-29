import { useEffect, useState } from "react";

/**
 * Rollout is sticky by construction: the server buckets on
 * sha256(deviceId + releaseId), so raising the percentage only ever adds
 * devices and lowering it never takes the update back from a device that
 * already installed. The confirm step exists to say so out loud.
 */
export function RolloutSlider({
  value,
  disabled,
  busy,
  onCommit,
}: {
  value: number;
  disabled?: boolean;
  busy?: boolean;
  onCommit: (percent: number) => void;
}) {
  const [pending, setPending] = useState(value);

  useEffect(() => setPending(value), [value]);

  const dirty = pending !== value;
  const lowering = pending < value;

  return (
    <div className="stack-sm">
      <div className="row">
        <span className="rollout-value">{pending}%</span>
        <input
          id="rollout-range"
          type="range"
          min={0}
          max={100}
          step={1}
          value={pending}
          disabled={disabled || busy}
          onChange={(event) => setPending(Number(event.target.value))}
          aria-label="Rollout percentage"
          aria-describedby="rollout-help"
        />
        <label className="sr-only" htmlFor="rollout-number">
          Rollout percentage
        </label>
        <input
          id="rollout-number"
          type="number"
          min={0}
          max={100}
          value={pending}
          disabled={disabled || busy}
          onChange={(event) =>
            setPending(Math.max(0, Math.min(100, Number(event.target.value) || 0)))
          }
          style={{ width: 78 }}
        />
      </div>

      <div className="rollout-scale" aria-hidden="true">
        <span>0%</span>
        <span>25%</span>
        <span>50%</span>
        <span>75%</span>
        <span>100%</span>
      </div>

      <p id="rollout-help" className="hint">
        Devices are bucketed deterministically per release, so the same device does not always land in
        the first slice.
      </p>

      {dirty ? (
        <div className={`notice${lowering ? " tone-warning" : ""}`}>
          <div className="stack-sm">
            <strong>
              Change rollout from {value}% to {pending}%?
            </strong>
            {lowering ? (
              <span>
                Lowering the percentage stops the release being offered to new devices, but it does not
                remove it from the devices that already installed it. To withdraw a release from every
                device, disable it or roll it back.
              </span>
            ) : (
              <span>
                {pending - value} more percent of devices will be offered this release on their next
                update check.
              </span>
            )}
            <div className="btn-group">
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onCommit(pending)}>
                {busy ? "Applying…" : `Set rollout to ${pending}%`}
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => setPending(value)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
