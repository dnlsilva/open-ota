import { useMemo } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatDay, formatNumber } from "../lib/format";
import { EmptyState } from "./EmptyState";

export interface DailyPoint {
  day: string;
  downloads: number;
  installs: number;
  ready: number;
  failed: number;
  rollbacks: number;
}

/**
 * Recharts renders colours as SVG presentation attributes, which resolve CSS
 * custom properties — so charts follow the theme with no JS colour plumbing.
 */
interface TooltipPayloadEntry {
  dataKey?: string | number;
  name?: string | number;
  value?: number | string;
  color?: string;
}

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string | number;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="chart-tooltip">
      <div className="t-day">{formatDay(String(label))}</div>
      {payload.map((entry) => (
        <div className="t-row" key={String(entry.dataKey)}>
          <span style={{ color: entry.color }}>{entry.name}</span>
          <b>{formatNumber(typeof entry.value === "number" ? entry.value : Number(entry.value))}</b>
        </div>
      ))}
    </div>
  );
}

const axisProps = {
  stroke: "var(--chart-axis)",
  tick: { fill: "var(--chart-axis)", fontSize: 11 },
  tickLine: false,
} as const;

export function ChartLegend({ keys }: { keys: Array<{ label: string; color: string }> }) {
  return (
    <div className="chart-legend">
      {keys.map((key) => (
        <span className="key" key={key.label}>
          <span className="swatch" style={{ background: key.color }} aria-hidden="true" />
          {key.label}
        </span>
      ))}
    </div>
  );
}

/**
 * Adoption over time: cumulative devices that reached `ready` on this release,
 * with cumulative rollbacks on the same axis — the curve flattening while the
 * red line climbs is exactly the shape an operator needs to catch.
 */
export function AdoptionChart({ daily }: { daily: DailyPoint[] }) {
  const data = useMemo(() => {
    let ready = 0;
    let rollbacks = 0;
    return daily.map((point) => {
      ready += point.ready;
      rollbacks += point.rollbacks;
      return { day: point.day, ready, rollbacks };
    });
  }, [daily]);

  if (data.length === 0) {
    return <EmptyState title="No adoption data yet">Devices report in as they take the release.</EmptyState>;
  }

  return (
    <div className="stack-sm">
      <div className="chart">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
            <defs>
              <linearGradient id="ota-adoption" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.55} />
                <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.04} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
            <XAxis dataKey="day" tickFormatter={formatDay} minTickGap={24} {...axisProps} />
            <YAxis allowDecimals={false} width={52} {...axisProps} />
            <Tooltip content={<ChartTooltip />} />
            <Area
              type="monotone"
              dataKey="ready"
              name="Ready (cumulative)"
              stroke="var(--chart-1)"
              strokeWidth={2}
              fill="url(#ota-adoption)"
            />
            <Area
              type="monotone"
              dataKey="rollbacks"
              name="Rollbacks (cumulative)"
              stroke="var(--chart-4)"
              strokeWidth={2}
              fill="var(--chart-4)"
              fillOpacity={0.12}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <ChartLegend
        keys={[
          { label: "Ready (cumulative)", color: "var(--chart-1)" },
          { label: "Rollbacks (cumulative)", color: "var(--chart-4)" },
        ]}
      />
    </div>
  );
}

/** Per-day counters — for spotting the day a release started failing. */
export function DailyChart({ daily }: { daily: DailyPoint[] }) {
  if (daily.length === 0) {
    return <EmptyState title="No daily counters yet">Nothing has been reported for this release.</EmptyState>;
  }

  return (
    <div className="stack-sm">
      <div className="chart">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={daily} margin={{ top: 8, right: 8, bottom: 0, left: -12 }} barGap={1}>
            <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
            <XAxis dataKey="day" tickFormatter={formatDay} minTickGap={24} {...axisProps} />
            <YAxis allowDecimals={false} width={52} {...axisProps} />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--chart-grid)", opacity: 0.4 }} />
            <Bar dataKey="downloads" name="Downloads" fill="var(--chart-1)" />
            <Bar dataKey="ready" name="Ready" fill="var(--chart-2)" />
            <Bar dataKey="failed" name="Failed" fill="var(--chart-3)" />
            <Bar dataKey="rollbacks" name="Rollbacks" fill="var(--chart-4)" />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ChartLegend
        keys={[
          { label: "Downloads", color: "var(--chart-1)" },
          { label: "Ready", color: "var(--chart-2)" },
          { label: "Failed", color: "var(--chart-3)" },
          { label: "Rollbacks", color: "var(--chart-4)" },
        ]}
      />
    </div>
  );
}
