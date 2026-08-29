import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { PreviewLinkResponse, Release, ReleaseStatus } from "@open-ota/shared";
import { client, errorMessage, useChannels, useRelease, useReleaseMetrics } from "../api/client";
import { DailyChart } from "../components/Chart";
import { EmptyState, ErrorState, Loading } from "../components/EmptyState";
import { Funnel } from "../components/Funnel";
import { ConfirmDialog, Modal } from "../components/Modal";
import { QrModal } from "../components/QrModal";
import { RolloutSlider } from "../components/RolloutSlider";
import { Pill, Stat, StatusPill, rollbackTone, successTone } from "../components/StatPill";
import { CopyButton } from "../components/CopyButton";
import { useToast } from "../components/Toast";
import {
  formatBytes,
  formatDateTime,
  formatNumber,
  formatPercent,
  formatRate,
  platformLabel,
  shortId,
} from "../lib/format";

export function ReleaseDetail() {
  const { projectId, releaseId } = useParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const release = useRelease(releaseId);
  const metrics = useReleaseMetrics(releaseId, 14);

  const [promoting, setPromoting] = useState(false);
  const [confirming, setConfirming] = useState<"disable" | "rollback" | null>(null);
  const [previewLink, setPreviewLink] = useState<PreviewLinkResponse | null>(null);

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ["release", releaseId] });
    void queryClient.invalidateQueries({ queryKey: ["release-metrics", releaseId] });
    void queryClient.invalidateQueries({ queryKey: ["releases"] });
    void queryClient.invalidateQueries({ queryKey: ["overview"] });
  }

  const patch = useMutation({
    mutationFn: (input: { status?: ReleaseStatus; rolloutPercent?: number }) =>
      client.updateRelease(releaseId as string, input),
    onSuccess: (_result, input) => {
      refresh();
      toast(
        input.status
          ? `Release is now ${input.status}`
          : `Rollout set to ${input.rolloutPercent}%`,
        "healthy",
      );
    },
    onError: (error) => toast(errorMessage(error), "critical"),
  });

  const rollback = useMutation({
    mutationFn: () => client.rollbackRelease(releaseId as string),
    onSuccess: (result) => {
      refresh();
      setConfirming(null);
      toast(
        result.target
          ? `Rolled back — devices converge to v${result.target.label}`
          : "Rolled back — devices return to the embedded bundle",
        "healthy",
      );
    },
    onError: (error) => toast(errorMessage(error), "critical"),
  });

  const preview = useMutation({
    mutationFn: () => client.createPreviewLink(releaseId as string, 15),
    onSuccess: (result) => setPreviewLink(result),
    onError: (error) => toast(errorMessage(error), "critical"),
  });

  if (release.isPending) return <Loading label="Loading release" rows={5} />;

  if (release.isError) {
    return (
      <ErrorState
        title="Could not load this release"
        message={errorMessage(release.error)}
        onRetry={() => void release.refetch()}
        secondary={
          <Link className="btn" to={`/p/${projectId}/releases`}>
            Back to releases
          </Link>
        }
      />
    );
  }

  const data = release.data?.release;
  if (!data) return null;

  const busy = patch.isPending || rollback.isPending;
  const canOffer = data.status === "active" || data.status === "paused";

  return (
    <div className="stack">
      <section className="card">
        <div className="card-head">
          <h2 style={{ fontSize: 18 }}>v{data.label}</h2>
          <span className="chip">{data.channel}</span>
          <span className="chip">{platformLabel(data.platform)}</span>
          <StatusPill status={data.status} />
          {data.mandatory ? (
            <Pill tone="warning" dot={false} title="Applied immediately instead of on the next launch">
              mandatory
            </Pill>
          ) : null}
          <span className="spacer" />
          <Link className="small" to={`/p/${projectId}/releases`}>
            All releases
          </Link>
        </div>

        <div className="card-body stack">
          {data.message ? <p>{data.message}</p> : null}

          <dl className="grid grid-3" style={{ margin: 0 }}>
            <Field label="Runtime version" value={<code>{data.runtimeVersion}</code>} />
            <Field label="Size" value={formatBytes(data.size)} />
            <Field label="Created" value={formatDateTime(data.createdAt)} />
            <Field
              label="Bundle sha256"
              value={
                <span className="row">
                  <code title={data.sha256}>{shortId(data.sha256)}</code>
                  <CopyButton value={data.sha256} label="Copy" what="Hash copied" className="btn btn-ghost btn-sm" />
                </span>
              }
            />
            <Field label="Git commit" value={data.gitCommit ? <code>{shortId(data.gitCommit)}</code> : "—"} />
            <Field label="Release id" value={<code title={data.id}>{shortId(data.id)}</code>} />
          </dl>

          <div className="btn-group">
            {data.status === "active" ? (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => patch.mutate({ status: "paused" })}
              >
                Pause
              </button>
            ) : null}

            {data.status === "paused" || data.status === "disabled" ? (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => patch.mutate({ status: "active" })}
              >
                {data.status === "paused" ? "Resume" : "Re-activate"}
              </button>
            ) : null}

            {canOffer ? (
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => setConfirming("disable")}>
                Disable
              </button>
            ) : null}

            {canOffer ? (
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => setConfirming("rollback")}>
                Roll back
              </button>
            ) : null}

            <button
              type="button"
              className="btn"
              disabled={busy || data.status === "pending"}
              onClick={() => setPromoting(true)}
            >
              Promote to channel
            </button>

            <span className="spacer" />

            <button
              type="button"
              className="btn btn-primary"
              disabled={preview.isPending || data.status === "pending"}
              onClick={() => preview.mutate()}
            >
              {preview.isPending ? "Signing link…" : "Open on device"}
            </button>
          </div>

          <p className="hint">
            Pause stops new devices from being offered this release while devices that already have it
            keep running it. Disable withdraws it from every device. Roll back disables it and lets
            devices converge to the previous active release, or to the embedded bundle.
          </p>
        </div>
      </section>

      <div className="grid grid-2">
        <section className="card">
          <div className="card-head">
            <h2>Funnel</h2>
            <span className="spacer" />
            <span className="small muted">Counters since publish</span>
          </div>
          <div className="card-body">
            {metrics.isPending ? (
              <Loading label="Loading metrics" />
            ) : metrics.isError ? (
              <ErrorState message={errorMessage(metrics.error)} onRetry={() => void metrics.refetch()} />
            ) : metrics.data ? (
              <div className="stack">
                <div className="grid grid-stats">
                  <Stat
                    label="Active devices"
                    value={formatNumber(metrics.data.activeDevices)}
                    sub="On this release right now"
                    tone="accent"
                  />
                  <Stat
                    label="Success rate"
                    value={formatPercent(metrics.data.successRate)}
                    sub="ready / installs"
                    tone={successTone(metrics.data.successRate)}
                  />
                  <Stat
                    label="Rollback rate"
                    value={formatPercent(metrics.data.rollbackRate)}
                    sub="rollbacks / installs"
                    tone={rollbackTone(metrics.data.rollbackRate)}
                  />
                </div>
                <Funnel funnel={metrics.data} />
              </div>
            ) : null}
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Rollout</h2>
            <span className="spacer" />
            <span className="small muted">Currently {data.rolloutPercent}%</span>
          </div>
          <div className="card-body">
            <RolloutSlider
              value={data.rolloutPercent}
              busy={patch.isPending}
              disabled={data.status === "disabled" || data.status === "pending"}
              onCommit={(percent) => patch.mutate({ rolloutPercent: percent })}
            />
            {data.status === "disabled" ? (
              <p className="hint">A disabled release is not offered to anyone, whatever the percentage.</p>
            ) : null}
          </div>
        </section>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Daily activity</h2>
          <span className="spacer" />
          <span className="small muted">Last 14 days</span>
        </div>
        <div className="card-body">
          {metrics.isPending ? (
            <Loading label="Loading daily counters" />
          ) : metrics.isError ? (
            <ErrorState message={errorMessage(metrics.error)} onRetry={() => void metrics.refetch()} />
          ) : metrics.data && metrics.data.daily.length > 0 ? (
            <DailyChart daily={metrics.data.daily} />
          ) : (
            <EmptyState title="No activity recorded yet">
              Counters arrive in batches from the SDK, so a release published minutes ago can still be
              empty here.
            </EmptyState>
          )}
        </div>
      </section>

      {promoting ? (
        <PromoteDialog release={data} onClose={() => setPromoting(false)} onDone={refresh} />
      ) : null}

      {confirming === "disable" ? (
        <ConfirmDialog
          title="Disable this release?"
          confirmLabel="Disable release"
          busy={patch.isPending}
          onClose={() => setConfirming(null)}
          onConfirm={() => {
            patch.mutate({ status: "disabled" });
            setConfirming(null);
          }}
        >
          Every device running v{data.label} will move off it on its next update check — to the newest
          release still available to them, or to the bundle embedded in the binary.
        </ConfirmDialog>
      ) : null}

      {confirming === "rollback" ? (
        <ConfirmDialog
          title="Roll back this release?"
          confirmLabel="Roll back"
          busy={rollback.isPending}
          onClose={() => setConfirming(null)}
          onConfirm={() => rollback.mutate()}
        >
          v{data.label} is disabled and devices converge to the previous active release on this channel.
          If there is none, they fall back to the embedded bundle.
        </ConfirmDialog>
      ) : null}

      {previewLink ? (
        <QrModal
          link={previewLink}
          releaseLabel={`v${data.label}`}
          onClose={() => setPreviewLink(null)}
          onRegenerate={() => {
            setPreviewLink(null);
            preview.mutate();
          }}
        />
      ) : null}
    </div>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="stat-label">{label}</dt>
      <dd style={{ margin: "2px 0 0" }}>{value}</dd>
    </div>
  );
}

function PromoteDialog({
  release,
  onClose,
  onDone,
}: {
  release: Release;
  onClose: () => void;
  onDone: () => void;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const channels = useChannels(release.projectId);
  const options = (channels.data?.channels ?? []).filter((channel) => channel.name !== release.channel);
  const [channel, setChannel] = useState("");
  const [rollout, setRollout] = useState(100);

  const promote = useMutation({
    mutationFn: () => client.promoteRelease(release.id, channel, rollout),
    onSuccess: (result) => {
      onDone();
      onClose();
      toast(`Promoted to ${channel} as v${result.release.label}`, "healthy");
      navigate(`/p/${release.projectId}/releases/${result.release.id}`);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (channel) promote.mutate();
  }

  return (
    <Modal
      title={`Promote v${release.label} to another channel`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="promote" className="btn btn-primary" disabled={!channel || promote.isPending}>
            {promote.isPending ? "Promoting…" : "Promote"}
          </button>
        </>
      }
    >
      <form id="promote" onSubmit={submit}>
        <div className="field">
          <label htmlFor="promote-channel">Target channel</label>
          <select id="promote-channel" value={channel} onChange={(event) => setChannel(event.target.value)} required>
            <option value="">Select a channel…</option>
            {options.map((item) => (
              <option key={item.id} value={item.name}>
                {item.name}
              </option>
            ))}
          </select>
          {channels.isPending ? <span className="hint">Loading channels…</span> : null}
          {options.length === 0 && !channels.isPending ? (
            <span className="hint">This project has no other channel to promote into.</span>
          ) : null}
        </div>

        <div className="field">
          <label htmlFor="promote-rollout">Initial rollout</label>
          <input
            id="promote-rollout"
            type="number"
            min={0}
            max={100}
            value={rollout}
            onChange={(event) => setRollout(Math.max(0, Math.min(100, Number(event.target.value) || 0)))}
          />
          <span className="hint">
            Promoting copies the same bundle into the target channel as a new release with its own label
            and its own counters. Nothing changes for {release.channel}.
          </span>
        </div>

        {promote.isError ? (
          <div className="error-box" role="alert">
            {errorMessage(promote.error)}
          </div>
        ) : null}
      </form>
    </Modal>
  );
}
