import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { PLATFORMS } from "@open-ota/shared";
import type { NativeVersionRow, Platform } from "@open-ota/shared";
import { errorMessage, useDistribution } from "../api/client";
import { EmptyState, ErrorState, Loading } from "../components/EmptyState";
import { Stat } from "../components/StatPill";
import { DataTable, ShareBar } from "../components/Table";
import { formatNumber, formatPercent, platformLabel } from "../lib/format";
import { ACTIVE_WINDOW_DAYS, DistributionTable } from "./ProjectHome";

const WINDOWS = [7, 30, 90];

export function Devices() {
  const { projectId } = useParams();
  const [platform, setPlatform] = useState<Platform | "all">("all");
  const [windowDays, setWindowDays] = useState(ACTIVE_WINDOW_DAYS);
  const distribution = useDistribution(projectId, platform, windowDays);

  const byPlatform = useMemo(() => {
    const totals = new Map<Platform, number>();
    for (const row of distribution.data?.nativeVersions ?? []) {
      totals.set(row.platform, (totals.get(row.platform) ?? 0) + row.devices);
    }
    const total = [...totals.values()].reduce((sum, value) => sum + value, 0);
    return [...totals.entries()]
      .map(([key, devices]) => ({
        platform: key,
        devices,
        percentOfBase: total > 0 ? (devices / total) * 100 : 0,
      }))
      .sort((a, b) => b.devices - a.devices);
  }, [distribution.data]);

  return (
    <div className="stack">
      <section className="card">
        <div className="card-head">
          <h2>Active devices</h2>
          <span className="spacer" />
          <div className="filters">
            <div className="field">
              <label htmlFor="device-platform">Platform</label>
              <select
                id="device-platform"
                value={platform}
                onChange={(event) => setPlatform(event.target.value as Platform | "all")}
              >
                <option value="all">All platforms</option>
                {PLATFORMS.map((item) => (
                  <option key={item} value={item}>
                    {platformLabel(item)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="device-window">Active window</label>
              <select
                id="device-window"
                value={windowDays}
                onChange={(event) => setWindowDays(Number(event.target.value))}
              >
                {WINDOWS.map((days) => (
                  <option key={days} value={days}>
                    Last {days} days
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="card-body stack">
          <div className="notice">
            A device counts as active when it has checked for an update in the last{" "}
            <b className="num">{windowDays}</b> days. Every launch already calls{" "}
            <code>/update-check</code>, so that check is the heartbeat — there is no separate session
            tracking, and an uninstalled app simply stops appearing.
          </div>

          {distribution.isPending ? <Loading label="Loading device distribution" rows={4} /> : null}

          {distribution.isError ? (
            <ErrorState
              message={errorMessage(distribution.error)}
              onRetry={() => void distribution.refetch()}
            />
          ) : null}

          {distribution.data ? (
            <div className="grid grid-stats">
              <Stat
                label="Active devices"
                value={formatNumber(distribution.data.totalDevices)}
                sub={`${platform === "all" ? "All platforms" : platformLabel(platform)} · ${windowDays}d window`}
                tone="accent"
              />
              <Stat
                label="OTA versions in the wild"
                value={formatNumber(distribution.data.releases.length)}
                sub="Including the embedded bundle"
              />
              <Stat
                label="Native versions in the wild"
                value={formatNumber(distribution.data.nativeVersions.length)}
                sub="Binary fragmentation across the store"
              />
            </div>
          ) : null}
        </div>
      </section>

      {distribution.data ? (
        <>
          <section className="card">
            <div className="card-head">
              <h2>By OTA release</h2>
              <span className="spacer" />
              <span className="small muted">Which JS bundle each device is running</span>
            </div>
            <div className="card-body tight">
              <DistributionTable projectId={projectId ?? ""} rows={distribution.data.releases} />
            </div>
          </section>

          <div className="grid grid-2">
            <section className="card">
              <div className="card-head">
                <h2>By native app version</h2>
                <span className="spacer" />
                <span className="small muted">Binaries installed from the stores</span>
              </div>
              <div className="card-body tight">
                <NativeVersionTable rows={distribution.data.nativeVersions} />
              </div>
            </section>

            <section className="card">
              <div className="card-head">
                <h2>By platform</h2>
              </div>
              <div className="card-body tight">
                <DataTable
                  rows={byPlatform}
                  minWidth={360}
                  rowKey={(row) => row.platform}
                  empty={<EmptyState title="No devices in this window" />}
                  columns={[
                    { key: "platform", header: "Platform", render: (row) => platformLabel(row.platform) },
                    {
                      key: "devices",
                      header: "Devices",
                      align: "end",
                      render: (row) => formatNumber(row.devices),
                    },
                    {
                      key: "share",
                      header: "Share",
                      render: (row) => (
                        <div className="row">
                          <ShareBar percent={row.percentOfBase} />
                          <span className="num" style={{ minWidth: 48 }}>
                            {formatPercent(row.percentOfBase)}
                          </span>
                        </div>
                      ),
                    },
                  ]}
                />
              </div>
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}

function NativeVersionTable({ rows }: { rows: NativeVersionRow[] }) {
  return (
    <DataTable
      rows={rows}
      minWidth={420}
      rowKey={(row, index) => `${row.nativeVersion}-${row.platform}-${index}`}
      empty={
        <EmptyState title="No native versions reported">
          Devices report their binary version on every update check.
        </EmptyState>
      }
      columns={[
        {
          key: "version",
          header: "Native version",
          render: (row) => <span className="num">{row.nativeVersion || "unknown"}</span>,
        },
        { key: "platform", header: "Platform", render: (row) => platformLabel(row.platform) },
        { key: "devices", header: "Devices", align: "end", render: (row) => formatNumber(row.devices) },
        {
          key: "share",
          header: "Share",
          render: (row) => (
            <div className="row">
              <ShareBar percent={row.percentOfBase} />
              <span className="num" style={{ minWidth: 48 }}>
                {formatPercent(row.percentOfBase)}
              </span>
            </div>
          ),
        },
      ]}
    />
  );
}
