import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { ChannelHealth, Release, RollbackEvent, VersionDistributionRow } from "@open-ota/shared";
import { errorMessage, useDistribution, useOverview, useReleaseMetrics } from "../api/client";
import { AdoptionChart } from "../components/Chart";
import { EmptyState, ErrorState, Loading } from "../components/EmptyState";
import { Pill, ReasonPill, Stat, StatusPill, rollbackTone, successTone } from "../components/StatPill";
import { DataTable, ShareBar } from "../components/Table";
import {
  formatBytes,
  formatNumber,
  formatPercent,
  formatRate,
  formatRelative,
  platformLabel,
} from "../lib/format";

/** Matches the default `window` of GET /projects/:id/distribution. */
export const ACTIVE_WINDOW_DAYS = 30;

const channelKey = (health: ChannelHealth) => `${health.channel}:${health.platform}`;

export function ProjectHome() {
  const { projectId } = useParams();
  const overview = useOverview(projectId);
  const distribution = useDistribution(projectId, "all", ACTIVE_WINDOW_DAYS);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const channels = useMemo(() => overview.data?.channels ?? [], [overview.data]);
  const live = useMemo(() => channels.filter((health) => health.currentRelease !== null), [channels]);
  const selected = live.find((health) => channelKey(health) === selectedKey) ?? live[0];
  const metrics = useReleaseMetrics(selected?.currentRelease?.id ?? null, 14);

  if (overview.isPending) return <Loading label="Loading project overview" rows={5} />;

  if (overview.isError) {
    return <ErrorState message={errorMessage(overview.error)} onRetry={() => void overview.refetch()} />;
  }

  const data = overview.data;
  if (!data) return null;

  if (data.recentReleases.length === 0) {
    return (
      <div className="card">
        <EmptyState
          title="No releases yet"
          command={"ota publish -c production --rollout 10"}
        >
          Publish from the app repository and this page fills in: current release per channel and
          platform, adoption over time, success and rollback rates, and the version spread across
          devices.
        </EmptyState>
      </div>
    );
  }

  const byChannel = new Map<string, ChannelHealth[]>();
  for (const health of channels) {
    const list = byChannel.get(health.channel);
    if (list) list.push(health);
    else byChannel.set(health.channel, [health]);
  }

  return (
    <div className="stack">
      <div className="grid grid-stats">
        <Stat
          label="Active devices"
          value={formatNumber(data.totalActiveDevices)}
          sub={`Seen in the last ${ACTIVE_WINDOW_DAYS} days`}
          tone="accent"
        />
        <Stat
          label="Current release"
          value={selected?.currentRelease ? `v${selected.currentRelease.label}` : "—"}
          sub={selected ? `${selected.channel} · ${platformLabel(selected.platform)}` : "No live release"}
        />
        <Stat
          label="Adoption"
          value={formatPercent(selected?.adoptionPercent)}
          sub="Devices on this release, in this channel"
        />
        <Stat
          label="Success rate"
          value={formatPercent(selected?.successRate)}
          sub="ready / installs"
          tone={successTone(selected?.successRate)}
        />
        <Stat
          label="Rollback rate"
          value={formatPercent(selected?.rollbackRate)}
          sub="rollbacks / installs"
          tone={rollbackTone(selected?.rollbackRate)}
        />
      </div>

      <div className="grid grid-2">
        <section className="card">
          <div className="card-head">
            <h2>Channels</h2>
            <span className="small muted">Current release per channel and platform</span>
          </div>
          <div className="card-body tight">
            {channels.length === 0 ? (
              <EmptyState title="No channels">Channels are created with the project.</EmptyState>
            ) : (
              [...byChannel.entries()].map(([channel, rows]) => (
                <div key={channel}>
                  <div className="group-head">
                    <h3>{channel}</h3>
                  </div>
                  {rows.map((health) => (
                    <div
                      key={channelKey(health)}
                      className={`channel-row${selected && channelKey(selected) === channelKey(health) ? " selected" : ""}`}
                    >
                      <div className="stack-sm">
                        <span className="chip">{platformLabel(health.platform)}</span>
                      </div>
                      <div className="stack-sm">
                        <div className="row row-wrap">
                          {health.currentRelease ? (
                            <>
                              <Link to={`/p/${projectId}/releases/${health.currentRelease.id}`}>
                                <strong>v{health.currentRelease.label}</strong>
                              </Link>
                              <StatusPill status={health.currentRelease.status} />
                              {health.currentRelease.rolloutPercent < 100 ? (
                                <Pill tone="accent" dot={false}>
                                  {health.currentRelease.rolloutPercent}% rollout
                                </Pill>
                              ) : null}
                              {health.currentRelease.mandatory ? (
                                <Pill tone="warning" dot={false}>
                                  mandatory
                                </Pill>
                              ) : null}
                            </>
                          ) : (
                            <span className="muted">No release — devices run the embedded bundle</span>
                          )}
                        </div>
                        <div className="channel-metrics">
                          <span>
                            <b>{formatNumber(health.activeDevices)}</b> devices
                          </span>
                          <span>
                            <b>{formatPercent(health.adoptionPercent)}</b> adoption
                          </span>
                          <span>
                            success <b>{formatPercent(health.successRate)}</b>
                          </span>
                          <span>
                            rollback{" "}
                            <b style={{ color: `var(--${rollbackTone(health.rollbackRate)})` }}>
                              {formatPercent(health.rollbackRate)}
                            </b>
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Adoption over time</h2>
            <span className="spacer" />
            <label className="sr-only" htmlFor="adoption-target">
              Release to chart
            </label>
            <select
              id="adoption-target"
              value={selected ? channelKey(selected) : ""}
              onChange={(event) => setSelectedKey(event.target.value)}
              disabled={live.length === 0}
              style={{ width: "auto" }}
            >
              {live.map((health) => (
                <option key={channelKey(health)} value={channelKey(health)}>
                  {health.channel} · {platformLabel(health.platform)} · v{health.currentRelease?.label}
                </option>
              ))}
            </select>
          </div>
          <div className="card-body">
            {!selected ? (
              <EmptyState title="No live release to chart">
                Publish or resume a release to see devices converge onto it.
              </EmptyState>
            ) : metrics.isPending ? (
              <Loading label="Loading adoption" />
            ) : metrics.isError ? (
              <ErrorState message={errorMessage(metrics.error)} onRetry={() => void metrics.refetch()} />
            ) : (
              <AdoptionChart daily={metrics.data?.daily ?? []} />
            )}
          </div>
        </section>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Version distribution</h2>
          <span className="spacer" />
          <span className="small muted">
            Devices seen in the last {ACTIVE_WINDOW_DAYS} days ·{" "}
            {formatNumber(distribution.data?.totalDevices)} total
          </span>
          <Link className="small" to={`/p/${projectId}/devices`}>
            Device breakdown
          </Link>
        </div>
        <div className="card-body tight">
          {distribution.isPending ? (
            <Loading label="Loading distribution" />
          ) : distribution.isError ? (
            <div style={{ padding: 14 }}>
              <ErrorState
                message={errorMessage(distribution.error)}
                onRetry={() => void distribution.refetch()}
              />
            </div>
          ) : (
            <DistributionTable projectId={projectId ?? ""} rows={distribution.data?.releases ?? []} />
          )}
        </div>
      </section>

      <div className="grid grid-2">
        <section className="card">
          <div className="card-head">
            <h2>Recent releases</h2>
            <span className="spacer" />
            <Link className="small" to={`/p/${projectId}/releases`}>
              All releases
            </Link>
          </div>
          <div className="card-body tight">
            <RecentReleases projectId={projectId ?? ""} releases={data.recentReleases} />
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Recent rollbacks</h2>
            <span className="spacer" />
            <span className="small muted">Devices that reverted after a failed launch</span>
          </div>
          <div className="card-body tight">
            <RecentRollbacks projectId={projectId ?? ""} rollbacks={data.recentRollbacks} />
          </div>
        </section>
      </div>
    </div>
  );
}

export function DistributionTable({ projectId, rows }: { projectId: string; rows: VersionDistributionRow[] }) {
  return (
    <DataTable
      rows={rows}
      minWidth={640}
      rowKey={(row, index) => `${row.releaseId ?? "embedded"}-${row.platform}-${index}`}
      empty={
        <EmptyState title="No devices reported yet">
          Devices appear after their first update check, which doubles as the heartbeat.
        </EmptyState>
      }
      columns={[
        {
          key: "release",
          header: "OTA version",
          render: (row) =>
            row.releaseId ? (
              <Link to={`/p/${projectId}/releases/${row.releaseId}`}>v{row.label}</Link>
            ) : (
              <span className="muted" title="Devices running the bundle shipped inside the binary">
                Embedded bundle
              </span>
            ),
        },
        { key: "platform", header: "Platform", render: (row) => platformLabel(row.platform) },
        { key: "devices", header: "Devices", align: "end", render: (row) => formatNumber(row.devices) },
        {
          key: "share",
          header: "Share of base",
          render: (row) => (
            <div className="row">
              <ShareBar percent={row.percentOfBase} />
              <span className="num" style={{ minWidth: 48 }}>
                {formatPercent(row.percentOfBase)}
              </span>
            </div>
          ),
        },
        { key: "installs", header: "Installs", align: "end", render: (row) => formatNumber(row.installs) },
        {
          key: "rollbacks",
          header: "Rollbacks",
          align: "end",
          render: (row) => (
            <span style={row.rollbacks > 0 ? { color: "var(--critical)", fontWeight: 600 } : undefined}>
              {formatNumber(row.rollbacks)}
            </span>
          ),
        },
      ]}
    />
  );
}

function RecentReleases({ projectId, releases }: { projectId: string; releases: Release[] }) {
  return (
    <DataTable
      rows={releases}
      minWidth={520}
      rowKey={(release) => release.id}
      empty={<EmptyState title="No releases yet" command="ota publish -c staging" />}
      columns={[
        {
          key: "label",
          header: "Release",
          render: (release) => <Link to={`/p/${projectId}/releases/${release.id}`}>v{release.label}</Link>,
        },
        { key: "platform", header: "Platform", render: (release) => platformLabel(release.platform) },
        { key: "channel", header: "Channel", render: (release) => release.channel },
        { key: "status", header: "Status", render: (release) => <StatusPill status={release.status} /> },
        {
          key: "rollout",
          header: "Rollout",
          align: "end",
          render: (release) => <span className="num">{release.rolloutPercent}%</span>,
        },
        { key: "size", header: "Size", align: "end", render: (release) => formatBytes(release.size) },
        {
          key: "created",
          header: "Created",
          align: "end",
          render: (release) => (
            <span title={release.createdAt} className="muted">
              {formatRelative(release.createdAt)}
            </span>
          ),
        },
      ]}
    />
  );
}

function RecentRollbacks({ projectId, rollbacks }: { projectId: string; rollbacks: RollbackEvent[] }) {
  return (
    <DataTable
      rows={rollbacks}
      minWidth={520}
      rowKey={(event) => event.id}
      empty={
        <EmptyState title="No rollbacks">
          Nothing has reverted. A device rolls back on its own when a release fails to reach{" "}
          <code>notifyAppReady()</code>.
        </EmptyState>
      }
      columns={[
        {
          key: "release",
          header: "Release",
          render: (event) =>
            event.releaseLabel !== null ? (
              <Link to={`/p/${projectId}/releases/${event.releaseId}`}>v{event.releaseLabel}</Link>
            ) : (
              <span className="muted">unknown</span>
            ),
        },
        { key: "reason", header: "Reason", render: (event) => <ReasonPill reason={event.reason} /> },
        {
          key: "platform",
          header: "Platform",
          render: (event) => (event.platform ? platformLabel(event.platform) : "—"),
        },
        {
          key: "native",
          header: "Native",
          render: (event) => <span className="num">{event.nativeVersion ?? "—"}</span>,
        },
        {
          key: "when",
          header: "When",
          align: "end",
          render: (event) => (
            <span title={event.createdAt} className="muted">
              {formatRelative(event.createdAt)}
            </span>
          ),
        },
      ]}
    />
  );
}
