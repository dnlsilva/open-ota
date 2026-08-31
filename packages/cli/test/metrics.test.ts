import { describe, expect, it } from "vitest";
import type { ReleaseMetrics } from "@open-ota/shared";

import { funnelRows } from "../src/commands/metrics.js";
import { formatBytes, formatPercent, formatTable } from "../src/output.js";

const metrics = (over: Partial<ReleaseMetrics> = {}): ReleaseMetrics => ({
  releaseId: "rel_1",
  label: 42,
  activeDevices: 1200,
  downloads: 1500,
  installs: 1400,
  ready: 1380,
  failed: 20,
  rollbacks: 8,
  successRate: 0.9857,
  rollbackRate: 0.0057,
  daily: [],
  ...over,
});

describe("table formatting", () => {
  it("aligns columns and right-aligns numbers", () => {
    const table = formatTable(
      [{ header: "RELEASE" }, { header: "DEVICES", align: "right" }],
      [
        ["v9", "7"],
        ["v10", "1200"],
      ],
    );
    expect(table.split("\n")).toEqual([
      "RELEASE  DEVICES",
      "v9             7",
      "v10         1200",
    ]);
  });

  it("widens a column to fit its longest cell", () => {
    const [header] = formatTable([{ header: "ID" }, { header: "N" }], [["0193a4c8", "1"]]).split("\n");
    expect(header).toBe("ID        N");
  });

  it("leaves no trailing whitespace", () => {
    for (const line of formatTable([{ header: "A" }, { header: "BBBB" }], [["aaaa", "b"]]).split("\n")) {
      expect(line).toBe(line.trimEnd());
    }
  });

  it("renders a header-only table when there are no rows", () => {
    expect(formatTable([{ header: "RELEASE" }], [])).toBe("RELEASE");
  });
});

describe("metrics rows", () => {
  it("renders the funnel with rates as percentages", () => {
    const [row] = funnelRows([metrics()], () => "ios");
    expect(row).toEqual(["v42", "ios", "1200", "1500", "1400", "1380", "20", "8", "98.6%", "0.6%"]);
  });

  it("shows an em dash when a rate is undefined for lack of installs", () => {
    const [row] = funnelRows([metrics({ installs: 0, successRate: null, rollbackRate: null })], () => "android");
    expect(row?.slice(-2)).toEqual(["—", "—"]);
  });

  it("formats sizes and percentages", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(1)).toBe("100.0%");
  });
});
