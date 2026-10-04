"use client";

import { AlertTriangle } from "lucide-react";
import { ChartRenderer } from "@/components/chat/ChartRenderer";
import type { DashboardItem } from "@/lib/types";

export const DISPLAY_LABELS: Record<string, string> = {
  kpi: "Number",
  line: "Line",
  area: "Area",
  bar: "Column",
  hbar: "Bar",
  pie: "Pie",
  donut: "Donut",
  table: "Table",
};

/** A chart visual's content. Rendered at real screen size (not a scaled
 * transform) so Recharts' hover/tooltip math stays exact at every zoom. */
export function ChartVisual({ item }: { item: DashboardItem }) {
  const cfg = item.config;
  const accent = cfg.color ? `var(--color-series-${cfg.color})` : "var(--accent)";
  const title = cfg.title?.trim() || item.question;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {cfg.show_title && (
        <div className="flex shrink-0 items-start gap-2 pb-2">
          <span className="mt-[0.45em] h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: accent }} />
          <h3 className="line-clamp-2 text-[14px] leading-snug font-semibold text-ink-primary" data-testid="tile-title">
            {title}
          </h3>
        </div>
      )}
      {/* height="100%" lets Recharts' own ResponsiveContainer resize itself
          via CSS against this flex-sized parent. A prior version measured
          this div with a separate JS ResizeObserver and fed the pixel
          height back into the chart rendered INSIDE it -- a feedback loop
          that corrupted Recharts' draw-in animation (Phase 7). */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {item.error ? (
          <div className="flex h-full items-start gap-2 pt-1 text-sm text-ink-secondary">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-status-warning" />
            <span>This visual&apos;s query failed: {item.error}</span>
          </div>
        ) : item.rows && item.columns ? (
          <ChartRenderer
            chart={item.chart}
            rows={item.rows}
            columns={item.columns}
            height="100%"
            displayType={cfg.display_type}
            color={cfg.color}
            showLegend={cfg.show_legend}
          />
        ) : (
          <p className="text-sm text-ink-muted">No data.</p>
        )}
      </div>
      {item.narration && !item.error && cfg.show_narration && (
        <p className="mt-2 line-clamp-2 shrink-0 text-[12px] leading-snug text-ink-secondary">{item.narration}</p>
      )}
    </div>
  );
}
