"use client";

import { Maximize2 } from "lucide-react";
import { memo, type PointerEvent as ReactPointerEvent } from "react";
import type { DashboardItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ChartVisual } from "./ChartVisual";
import type { Rect } from "./geometry";
import { setCaretPoint } from "./richtext";
import { TextBox } from "./TextBox";
import { frameStyle } from "./visualStyle";

/**
 * One visual on the page, absolutely positioned in screen px (page px x
 * zoom). Purely presentational: pointer-downs are forwarded to the canvas,
 * which owns drag/resize/snap state. Memoized -- during a drag only the
 * dragged item gets a new `live` rect, every other chart skips re-rendering.
 */
export const CanvasItem = memo(function CanvasItem({
  item,
  live,
  scale,
  editMode,
  selected,
  editingText,
  onPointerDown,
  onDoubleClick,
  onEditorMount,
  onTextInput,
  onGrow,
  onFocusVisual,
}: {
  item: DashboardItem;
  live: Rect | undefined;
  scale: number;
  editMode: boolean;
  selected: boolean;
  editingText: boolean;
  onPointerDown: (e: ReactPointerEvent, id: string) => void;
  onDoubleClick: (id: string) => void;
  onEditorMount: (el: HTMLDivElement | null) => void;
  onTextInput: (id: string, html: string) => void;
  onGrow: (id: string, height: number) => void;
  onFocusVisual: (id: string) => void;
}) {
  const r = live ?? item.layout;
  const isText = item.kind === "text";
  // A text box lays its content out at page size, so mid-resize it has to
  // see the LIVE width/height or its text would reflow only on release.
  const textItem = live && isText ? { ...item, layout: { ...item.layout, w: r.w, h: r.h } } : item;

  return (
    <div
      data-testid={isText ? "text-tile" : "chart-tile"}
      data-item-id={item.id}
      onPointerDown={(e) => onPointerDown(e, item.id)}
      onDoubleClick={(e) => {
        if (!isText || !editMode || editingText) return;
        setCaretPoint(e.clientX, e.clientY);
        onDoubleClick(item.id);
      }}
      className={cn(
        "group absolute overflow-hidden",
        // select-none: dragging across a text box must move it, not start
        // a native text selection (real bug: words highlighted mid-drag)
        editMode && !editingText && "cursor-move select-none",
        editMode && !selected && "hover:outline hover:outline-1 hover:outline-accent/50"
      )}
      style={{
        left: r.x * scale,
        top: r.y * scale,
        width: r.w * scale,
        height: r.h * scale,
        zIndex: item.layout.z,
        ...frameStyle(item, scale),
      }}
    >
      {isText ? (
        <TextBox
          item={textItem}
          scale={scale}
          editing={editingText}
          onEditorMount={onEditorMount}
          onInput={(html) => onTextInput(item.id, html)}
          onGrow={(h) => onGrow(item.id, h)}
        />
      ) : (
        <div className={cn("h-full", editMode && "pointer-events-none")}>
          <ChartVisual item={item} />
        </div>
      )}

      {/* Power BI "focus mode": blow one visual up to fill the screen. */}
      {!editMode && !isText && (
        <button
          onClick={() => onFocusVisual(item.id)}
          aria-label="Focus mode"
          title="Focus mode"
          className="absolute top-2 right-2 flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg border border-border bg-surface-raised/90 text-ink-muted opacity-0 backdrop-blur transition-opacity group-hover:opacity-100 hover:text-ink-primary focus-visible:opacity-100"
        >
          <Maximize2 size={13} />
        </button>
      )}
    </div>
  );
});
