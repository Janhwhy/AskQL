"use client";

import { X } from "lucide-react";
import { ChartRenderer } from "@/components/chat/ChartRenderer";
import type { DashboardItem } from "@/lib/types";

export function DashboardTile({
  item,
  onRemove,
}: {
  item: DashboardItem;
  onRemove: () => void;
}) {
  return (
    // Real bug, reported live: the whole chart body used to carry
    // "no-drag" (see the comment below on why the OBSERVER was removed --
    // this is a separate concern, drag eligibility), leaving only the
    // ~20px title strip draggable. Nobody discovers a 20px sliver as "the
    // drag handle" -- dragging from the chart itself (the natural first
    // attempt) silently did nothing. cursor-grab is applied to the whole
    // tile now; only the remove button opts out via "no-drag". A table
    // tile's own internal scroll (wheel) is unaffected since wheel events
    // don't trigger react-draggable's mousedown-based drag.
    <div className="group flex h-full cursor-grab flex-col overflow-hidden rounded-2xl border border-border bg-surface p-4 active:cursor-grabbing">
      <div className="mb-2 flex items-start justify-between gap-2">
        <h3 className="line-clamp-2 text-sm font-medium text-ink-primary">{item.question}</h3>
        <button
          onClick={onRemove}
          title="Remove from dashboard"
          className="no-drag shrink-0 cursor-pointer rounded-full p-1 text-ink-muted transition-colors hover:bg-status-critical/10 hover:text-status-critical"
        >
          <X size={14} />
        </button>
      </div>

      {/* height="100%" lets Recharts' own ResponsiveContainer resize itself
          via CSS against this flex-sized parent. A prior version measured
          this div with a separate JS ResizeObserver and fed the pixel
          height back into the chart rendered INSIDE it -- a feedback loop
          (observed size depending on content sized by the observed value)
          that corrupted Recharts' line/pie draw-in animation: valid SVG
          paths with real geometry and opacity:1 in the DOM, but nothing
          ever visually finished drawing. overflow-hidden (not auto) so a
          mid-resize frame never shows a transient scrollbar. */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {item.error ? (
          <p className="text-sm text-status-critical">{item.error}</p>
        ) : item.chart && item.rows && item.columns ? (
          <ChartRenderer chart={item.chart} rows={item.rows} columns={item.columns} height="100%" />
        ) : (
          <p className="text-sm text-ink-muted">No data.</p>
        )}
      </div>

      {item.narration && !item.error && (
        <p className="mt-2 line-clamp-2 text-xs text-ink-secondary">{item.narration}</p>
      )}
    </div>
  );
}
