import { useMemo } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { PLATFORMS, RELEASE_STATUSES } from "@open-ota/shared";
import type { Platform, Release, ReleaseStatus } from "@open-ota/shared";
import { errorMessage, useChannels, useReleases } from "../api/client";
import { EmptyState, ErrorState, Loading } from "../components/EmptyState";
import { Pill, StatusPill } from "../components/StatPill";
import { DataTable } from "../components/Table";
import { formatBytes, formatNumber, formatRelative, platformLabel } from "../lib/format";

interface ReleaseGroup {
  key: string;
  releases: Release[];
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function Releases() {
  const { projectId } = useParams();
  const [params, setParams] = useSearchParams();
  const channels = useChannels(projectId);

  const channel = params.get("channel") ?? "";
  const platform = (params.get("platform") ?? "") as Platform | "";
  const status = (params.get("status") ?? "") as ReleaseStatus | "";
  const filtered = Boolean(channel || platform || status);

  const releases = useReleases(projectId, {
    channel: channel || undefined,
    platform: platform || undefined,
    status: status || undefined,
  });

  /** iOS and Android published by one `ota publish` share a groupId and read as one release. */
  const groups = useMemo<ReleaseGroup[]>(() => {
    const byGroup = new Map<string, Release[]>();
    for (const release of releases.data?.releases ?? []) {
      const key = release.groupId ?? release.id;
      const list = byGroup.get(key);
      if (list) list.push(release);
      else byGroup.set(key, [release]);
    }
    return [...byGroup.entries()]
      .map(([key, list]) => ({
        key,
        releases: [...list].sort((a, b) => a.platform.localeCompare(b.platform)),
      }))
      .sort((a, b) => (b.releases[0]?.createdAt ?? "").localeCompare(a.releases[0]?.createdAt ?? ""));
  }, [releases.data]);

  function setFilter(name: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    setParams(next, { replace: true });
  }

  return (
    <div className="stack">
      <section className="card">
        <div className="card-head">
          <h2>Releases</h2>
          <span className="spacer" />
          <span className="small muted">
            {formatNumber(groups.length)} logical {groups.length === 1 ? "release" : "releases"} ·{" "}
            {formatNumber(releases.data?.releases.length ?? 0)} platform builds
          </span>
        </div>

        <div className="card-body">
          <div className="filters">
            <div className="field">
              <label htmlFor="filter-channel">Channel</label>
              <select
                id="filter-channel"
                value={channel}
                onChange={(event) => setFilter("channel", event.target.value)}
              >
                <option value="">All channels</option>
                {(channels.data?.channels ?? []).map((item) => (
                  <option key={item.id} value={item.name}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="filter-platform">Platform</label>
              <select
                id="filter-platform"
                value={platform}
                onChange={(event) => setFilter("platform", event.target.value)}
              >
                <option value="">All platforms</option>
                {PLATFORMS.map((item) => (
                  <option key={item} value={item}>
                    {platformLabel(item)}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="filter-status">Status</label>
              <select
                id="filter-status"
                value={status}
                onChange={(event) => setFilter("status", event.target.value)}
              >
                <option value="">Any status</option>
                {RELEASE_STATUSES.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </div>

            {filtered ? (
              <button type="button" className="btn" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
                Clear filters
              </button>
            ) : null}
          </div>
        </div>

        <div className="card-body tight">
          {releases.isPending ? <Loading label="Loading releases" rows={4} /> : null}

          {releases.isError ? (
            <div style={{ padding: 14 }}>
              <ErrorState message={errorMessage(releases.error)} onRetry={() => void releases.refetch()} />
            </div>
          ) : null}

          {releases.data ? (
            <DataTable
              rows={groups}
              minWidth={860}
              rowKey={(group) => group.key}
              empty={
                filtered ? (
                  <EmptyState
                    title="No releases match these filters"
                    action={
                      <button type="button" className="btn" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
                        Clear filters
                      </button>
                    }
                  />
                ) : (
                  <EmptyState title="No releases yet" command="ota publish -c staging --rollout 10">
                    A publish uploads one bundle per platform and links them with a group id, so iOS and
                    Android land here as a single logical release.
                  </EmptyState>
                )
              }
              columns={[
                {
                  key: "label",
                  header: "Release",
                  render: (group) => {
                    const labels = unique(group.releases.map((release) => `v${release.label}`));
                    const message = group.releases.find((release) => release.message)?.message;
                    return (
                      <div className="stack-sm">
                        <strong>{labels.join(" / ")}</strong>
                        {message ? (
                          <span className="small muted" title={message}>
                            {message}
                          </span>
                        ) : null}
                      </div>
                    );
                  },
                },
                {
                  key: "platform",
                  header: "Platform",
                  render: (group) => (
                    <div className="row row-wrap">
                      {group.releases.map((release) => (
                        <Link
                          key={release.id}
                          className="chip"
                          to={`/p/${projectId}/releases/${release.id}`}
                          title={`Open v${release.label} for ${platformLabel(release.platform)}`}
                        >
                          {platformLabel(release.platform)}
                        </Link>
                      ))}
                    </div>
                  ),
                },
                {
                  key: "channel",
                  header: "Channel",
                  render: (group) => unique(group.releases.map((release) => release.channel)).join(", "),
                },
                {
                  key: "status",
                  header: "Status",
                  render: (group) => (
                    <div className="row row-wrap">
                      {unique(group.releases.map((release) => release.status)).map((value) => (
                        <StatusPill key={value} status={value} />
                      ))}
                      {group.releases.some((release) => release.mandatory) ? (
                        <Pill tone="warning" dot={false}>
                          mandatory
                        </Pill>
                      ) : null}
                    </div>
                  ),
                },
                {
                  key: "rollout",
                  header: "Rollout",
                  align: "end",
                  render: (group) => (
                    <span className="num">
                      {unique(group.releases.map((release) => `${release.rolloutPercent}%`)).join(" / ")}
                    </span>
                  ),
                },
                {
                  key: "runtime",
                  header: "Runtime",
                  render: (group) => (
                    <span className="mono muted" title="Fingerprint of the native project this bundle targets">
                      {unique(group.releases.map((release) => release.runtimeVersion)).join(", ")}
                    </span>
                  ),
                },
                {
                  key: "size",
                  header: "Size",
                  align: "end",
                  render: (group) =>
                    formatBytes(group.releases.reduce((total, release) => total + release.size, 0)),
                },
                {
                  key: "created",
                  header: "Created",
                  align: "end",
                  render: (group) => {
                    const createdAt = group.releases[0]?.createdAt;
                    return (
                      <span className="muted" title={createdAt}>
                        {formatRelative(createdAt)}
                      </span>
                    );
                  },
                },
              ]}
            />
          ) : null}
        </div>
      </section>
    </div>
  );
}
