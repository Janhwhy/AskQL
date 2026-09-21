"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ChartDecision, Row } from "@/lib/types";

const SERIES_COLORS = [
  "var(--color-series-1)",
  "var(--color-series-2)",
  "var(--color-series-3)",
  "var(--color-series-4)",
  "var(--color-series-5)",
  "var(--color-series-6)",
  "var(--color-series-7)",
  "var(--color-series-8)",
];

/**
 * Formats by what the COLUMN NAME says the value is, not by guessing from
 * the number's shape. A shape-only guess ("non-integer -> money") actively
 * mislabels real metrics here — avg_resolution_time_days (e.g. 3.30) is
 * days, not dollars, and churn_rate (e.g. 0.1496) is a fraction, not a
 * plain number. Column names are raw SQL aliases (`sum(sales.amount)`,
 * `avg(date_diff('day', opened_at, closed_at))`), so this matches on
 * keywords within them rather than expecting a clean identifier.
 */
function formatValue(v: unknown, columnName = ""): string {
  if (typeof v !== "number") return String(v ?? "");

  const col = columnName.toLowerCase();
  if (/rate\b/.test(col) && !/day|date/.test(col) && v >= -1 && v <= 1) {
    return `${(v * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
  }
  if (/amount|revenue|price|deal_size|cost/.test(col)) {
    return v.toLocaleString(undefined, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    });
  }
  if (/date_diff|resolution_time|\bdays?\b/.test(col)) {
    const formatted = v.toLocaleString(undefined, { maximumFractionDigits: 1 });
    return `${formatted} day${v === 1 ? "" : "s"}`;
  }
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatAxisTick(v: unknown): string {
  if (typeof v === "number") {
    // Real bug, caught from a screenshot: k-only formatting produced
    // "10,000k" for a value in the millions — 7 characters, wider than the
    // Y axis's fixed width, so Recharts clipped the leading digit and it
    // rendered as "0,000k". M/B suffixes keep large-number labels short
    // enough to always fit, not just usually.
    const abs = Math.abs(v);
    if (abs >= 1_000_000_000) return `${(v / 1_000_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })}B`;
    if (abs >= 1_000_000) return `${(v / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })}M`;
    if (abs >= 1000) return `${(v / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}k`;
    return v.toLocaleString();
  }
  const s = String(v ?? "");
  // ISO date -> short label
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return s;
}

const CATEGORY_LABEL_MAX = 18;

/**
 * Truncates long category names for the axis tick specifically — chasing
 * exact pixel math to fit an arbitrarily long string (up to 29 characters
 * in real category names here) kept either clipping mid-word or forcing an
 * increasingly tall axis area for the one longest label. Real dashboard
 * tools truncate long axis labels for exactly this reason; the full name
 * is never actually lost, it's still in the tooltip (formatValue/labelFormatter
 * below use the raw, untruncated row value, not this).
 */
function formatCategoryTick(v: unknown): string {
  const s = String(v ?? "");
  return s.length > CATEGORY_LABEL_MAX ? `${s.slice(0, CATEGORY_LABEL_MAX - 1)}…` : s;
}

/** Pivots long-format rows (one row per x+series combo) into wide format
 * (one row per x, one field per series) — what Recharts needs to draw
 * multiple lines/bar groups from a single dataset. */
function pivotBySeries(rows: Row[], x: string, y: string, series: string) {
  const byX = new Map<string, Record<string, unknown>>();
  const seriesKeys = new Set<string>();
  for (const row of rows) {
    const xVal = String(row[x]);
    const seriesVal = String(row[series]);
    seriesKeys.add(seriesVal);
    const entry = byX.get(xVal) ?? { [x]: row[x] };
    entry[seriesVal] = row[y];
    byX.set(xVal, entry);
  }
  return { data: Array.from(byX.values()), seriesKeys: Array.from(seriesKeys) };
}

const tooltipStyle = {
  background: "var(--color-surface-raised)",
  border: "1px solid var(--color-border-strong)",
  borderRadius: 8,
  fontSize: 13,
  padding: "8px 12px",
  boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
};

function KpiTile({ rows, y }: { rows: Row[]; y: string }) {
  // No separate caption here on purpose — the narration sentence directly
  // above already gives full context (CLAUDE.md's "hero number" pattern:
  // a standalone stat needs surrounding prose, not a second, redundant
  // label repeating the question back).
  const value = rows[0]?.[y];
  return (
    <span className="block py-1 text-[clamp(2rem,5vw,2.75rem)] font-semibold tracking-tight tabular-nums text-ink-primary">
      {formatValue(value, y)}
    </span>
  );
}

function LineChartView({ rows, chart, height }: { rows: Row[]; chart: ChartDecision; height: number | `${number}%` }) {
  const { x, y, series } = chart;
  if (!x || !y) return null;

  if (series) {
    const { data, seriesKeys } = pivotBySeries(rows, x, y, series);
    return (
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
          <XAxis
            dataKey={(row) => row[x]}
            tickFormatter={formatAxisTick}
            stroke="var(--color-ink-muted)"
            fontSize={12}
            tickLine={false}
            axisLine={{ stroke: "var(--color-border-strong)" }}
          />
          <YAxis
            tickFormatter={formatAxisTick}
            stroke="var(--color-ink-muted)"
            fontSize={12}
            tickLine={false}
            axisLine={false}
            width={48}
          />
          <Tooltip contentStyle={tooltipStyle} labelFormatter={formatAxisTick} formatter={(v, name) => formatValue(v, String(name))} />
          <Legend wrapperStyle={{ fontSize: 12, color: "var(--color-ink-secondary)" }} />
          {seriesKeys.map((key, i) => (
            <Line
              key={key}
              type="monotone"
              dataKey={(row) => row[key]}
              stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
        <XAxis
          dataKey={(row) => row[x]}
          tickFormatter={formatAxisTick}
          stroke="var(--color-ink-muted)"
          fontSize={12}
          tickLine={false}
          axisLine={{ stroke: "var(--color-border-strong)" }}
        />
        <YAxis
          tickFormatter={formatAxisTick}
          stroke="var(--color-ink-muted)"
          fontSize={12}
          tickLine={false}
          axisLine={false}
          width={48}
        />
        <Tooltip contentStyle={tooltipStyle} labelFormatter={formatAxisTick} formatter={(v, name) => formatValue(v, String(name))} />
        <Line
          type="monotone"
          dataKey={(row) => row[y]}
          stroke="var(--color-series-2)"
          strokeWidth={2.5}
          dot={rows.length <= 20}
          activeDot={{ r: 4 }}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

function BarChartView({ rows, chart, height }: { rows: Row[]; chart: ChartDecision; height: number | `${number}%` }) {
  const { x, y, series } = chart;
  if (!x || !y) return null;

  // Real bug, caught from a screenshot: only row COUNT triggered rotation,
  // so 5 bars with long labels ("Infrastructure & Hosting",
  // "Collaboration & Productivity") stayed horizontal and visually
  // collided even though there were far fewer than 6 of them. Label
  // LENGTH matters at least as much as count for whether horizontal text
  // fits.
  const maxLabelLength = Math.max(...rows.map((r) => String(r[x]).length));
  const rotateLabels = rows.length > 6 || maxLabelLength > 10;
  // A rotated label's leftward/downward extent scales with its own
  // length — chasing exact pixel math for an unbounded string kept either
  // clipping or forcing an unreasonably tall chart for one long outlier.
  // formatCategoryTick truncates the DISPLAYED label to a fixed max
  // length, which makes the space this needs bounded and predictable —
  // these margins are sized for that cap, not for an arbitrary string.
  const xAxisProps = {
    dataKey: (row: Row) => row[x],
    tickFormatter: formatCategoryTick,
    stroke: "var(--color-ink-muted)",
    fontSize: 12,
    tickLine: false,
    axisLine: { stroke: "var(--color-border-strong)" },
    interval: 0 as const,
    angle: rotateLabels ? -45 : 0,
    textAnchor: (rotateLabels ? "end" : "middle") as "end" | "middle",
    // The REAL lever for a rotated label's clipping — Recharts reserves
    // exactly this many px for the axis band regardless of the outer
    // ResponsiveContainer's total height (raising that instead just made
    // the bars taller, measured zero change in the actual overflow).
    // Measured directly: an 18-char label at -45deg overflowed a 70px
    // band by up to ~21px, so 70 was never enough — 100 clears the
    // measured worst case with real margin, not another guess.
    height: rotateLabels ? 100 : 24,
  };
  const yAxisProps = {
    tickFormatter: formatAxisTick,
    stroke: "var(--color-ink-muted)",
    fontSize: 12,
    tickLine: false,
    axisLine: false,
    width: 48,
  };

  if (series) {
    // "Grouped" (region repeats per date) and "1:1-tagged" (each product
    // has exactly one category) are different shapes needing different
    // charts — real bug, caught from a live screenshot: treating every
    // series case as "grouped" pivoted a 1:1 mapping into mostly-empty
    // per-category Bar series (one real value, rest undefined per bar),
    // rendering as scattered bars with an unreadable one-swatch-per-row
    // legend. Only pivot when x genuinely repeats.
    const xValues = rows.map((r) => String(r[x]));
    const isGrouped = new Set(xValues).size < xValues.length;

    if (isGrouped) {
      const { data, seriesKeys } = pivotBySeries(rows, x, y, series);
      return (
        <ResponsiveContainer width="100%" height={height}>
          <BarChart data={data} margin={{ top: 8, right: 12, left: rotateLabels ? 60 : 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
            <XAxis {...xAxisProps} />
            <YAxis {...yAxisProps} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v, name) => formatValue(v, String(name))} cursor={{ fill: "var(--color-accent-wash)" }} />
            <Legend wrapperStyle={{ fontSize: 12, color: "var(--color-ink-secondary)" }} />
            {seriesKeys.map((key, i) => (
              <Bar key={key} dataKey={(row) => row[key]} fill={SERIES_COLORS[i % SERIES_COLORS.length]} radius={[3, 3, 0, 0]} maxBarSize={40} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      );
    }

    // Each x is unique — one bar per row, colored by its series value
    // (e.g. product -> category) instead of faking a grouped series.
    const seriesValues = Array.from(new Set(rows.map((r) => String(r[series]))));
    const colorFor = (v: string) => SERIES_COLORS[seriesValues.indexOf(v) % SERIES_COLORS.length];
    return (
      // flex column with the chart as the ONLY flex-1 child: a plain block
      // div's height is auto (indefinite), which breaks CSS percentage-
      // height resolution for ResponsiveContainer's height="100%" (dashboard
      // tiles) -- real bug, caught live: Recharts ended up with a literal
      // `height: 0` container and rendered nothing, despite the legend
      // below it working fine. A flex item's height IS definite after
      // layout, so "100%" resolves correctly through it.
      <div className="flex h-full flex-col">
        <div className="min-h-0 flex-1">
          <ResponsiveContainer width="100%" height={height}>
            <BarChart data={rows} margin={{ top: 8, right: 12, left: rotateLabels ? 60 : 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
              <XAxis {...xAxisProps} />
              <YAxis {...yAxisProps} />
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(v, name) => [formatValue(v, String(name)), String(name)]}
                labelFormatter={(label, payload) =>
                  payload?.[0] ? `${label} — ${String(payload[0].payload[series])}` : label
                }
                cursor={{ fill: "var(--color-accent-wash)" }}
              />
              <Bar dataKey={(row) => row[y]} radius={[3, 3, 0, 0]} maxBarSize={32} isAnimationActive={false}>
                {rows.map((row, i) => (
                  <Cell key={i} fill={colorFor(String(row[series]))} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-3 shrink-0 flex flex-wrap gap-x-4 gap-y-1.5">
          {seriesValues.map((v) => (
            <span key={v} className="flex items-center gap-1.5 text-xs text-ink-secondary">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: colorFor(v) }} />
              {v}
            </span>
          ))}
        </div>
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={{ top: 8, right: 12, left: rotateLabels ? 60 : 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
        <XAxis {...xAxisProps} />
        <YAxis {...yAxisProps} />
        <Tooltip contentStyle={tooltipStyle} formatter={(v, name) => formatValue(v, String(name))} cursor={{ fill: "var(--color-accent-wash)" }} />
        <Bar dataKey={(row) => row[y]} fill="var(--color-series-2)" radius={[3, 3, 0, 0]} maxBarSize={48} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

const PIE_SLICE_CAP = 8; // matches SERIES_COLORS.length — beyond this a pie
// is unreadable regardless of what was asked for, so fall back to a bar.

function PieChartView({ rows, chart, height }: { rows: Row[]; chart: ChartDecision; height: number | `${number}%` }) {
  const { x, y } = chart;
  if (!x || !y) return null;

  if (rows.length > PIE_SLICE_CAP) {
    return (
      <div className="flex h-full flex-col">
        <p className="mb-2 shrink-0 text-xs text-ink-muted">
          Too many slices for a readable pie ({rows.length}) — showing as a bar chart instead.
        </p>
        <div className="min-h-0 flex-1">
          <BarChartView rows={rows} chart={{ ...chart, chart_type: "bar" }} height={height} />
        </div>
      </div>
    );
  }

  const total = rows.reduce((sum, row) => sum + (Number(row[y]) || 0), 0);

  return (
    // See the matching comment on the bar chart's 1:1 branch above --
    // ResponsiveContainer's height="100%" only resolves through a parent
    // with a DEFINITE height, which a plain block div (height:auto) isn't.
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height={height}>
          <PieChart>
            <Pie
              data={rows}
              dataKey={(row) => row[y]}
              nameKey={(row) => row[x]}
              innerRadius={56}
              outerRadius={100}
              paddingAngle={2}
              stroke="var(--color-surface)"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {rows.map((_, i) => (
                <Cell key={i} fill={SERIES_COLORS[i % SERIES_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(v, _name, item) => {
                const pct = total ? ((Number(v) / total) * 100).toFixed(1) : "0";
                return [`${formatValue(v, y)} (${pct}%)`, String(item?.payload?.[x] ?? "")];
              }}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-3 shrink-0 flex flex-wrap gap-x-4 gap-y-1.5">
        {rows.map((row, i) => (
          <span key={i} className="flex items-center gap-1.5 text-xs text-ink-secondary">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
            {String(row[x])}
          </span>
        ))}
      </div>
    </div>
  );
}

function TableView({ rows, columns }: { rows: Row[]; columns: string[] }) {
  if (rows.length === 0) {
    return <p className="py-4 text-sm text-ink-muted">No rows returned.</p>;
  }
  return (
    <div className="max-h-80 overflow-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 bg-surface-raised">
          <tr>
            {columns.map((col) => (
              <th
                key={col}
                className="border-b border-border px-3 py-2 text-left font-medium text-ink-secondary"
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="odd:bg-surface even:bg-surface-raised/40">
              {columns.map((col) => (
                <td key={col} className="border-b border-border px-3 py-2 tabular-nums text-ink-primary">
                  {formatValue(row[col], col)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ChartRenderer({
  chart,
  rows,
  columns,
  height = 280,
}: {
  chart: ChartDecision;
  rows: Row[];
  columns: string[];
  /** Defaults to the chat view's fixed 280px. Dashboard tiles pass "100%"
   * so Recharts' own ResponsiveContainer resize-observes the flex parent
   * directly via CSS -- a real bug, caught live: an earlier version
   * measured the tile's content div with a SEPARATE ResizeObserver in JS
   * and fed that pixel height back into this same chart, which is itself
   * inside the observed div. That created a feedback loop (observed size
   * depends on rendered content driven by the observed size) that
   * corrupted Recharts' line/pie draw-in animation -- the DOM had valid
   * paths with real geometry and opacity:1, but visually never finished
   * drawing. Letting ResponsiveContainer own its own measurement removes
   * the loop entirely. */
  height?: number | `${number}%`;
}) {
  if (chart.chart_type === "kpi" && chart.y) {
    return <KpiTile rows={rows} y={chart.y} />;
  }
  if (chart.chart_type === "line") {
    return <LineChartView rows={rows} chart={chart} height={height} />;
  }
  if (chart.chart_type === "bar") {
    return <BarChartView rows={rows} chart={chart} height={height} />;
  }
  if (chart.chart_type === "pie") {
    return <PieChartView rows={rows} chart={chart} height={height} />;
  }
  return <TableView rows={rows} columns={columns} />;
}
