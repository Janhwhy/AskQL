"use client";

import { ArrowDownToLine, ArrowUpToLine, Copy, Pencil, Trash2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { DashboardItem, ReportPage, TileConfig } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CanvasItem } from "./CanvasItem";
import { snapMove, snapResize, type Guide, type Handle, type Rect } from "./geometry";
import { setCaretPoint } from "./richtext";
import { TextToolbar } from "./TextToolbar";

export type Zoom = "fit" | number;
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const HANDLE_POS: Record<Handle, string> = {
  nw: "-top-[5px] -left-[5px] cursor-nwse-resize",
  n: "-top-[5px] left-1/2 -translate-x-1/2 cursor-ns-resize",
  ne: "-top-[5px] -right-[5px] cursor-nesw-resize",
  e: "top-1/2 -right-[5px] -translate-y-1/2 cursor-ew-resize",
  se: "-bottom-[5px] -right-[5px] cursor-nwse-resize",
  s: "-bottom-[5px] left-1/2 -translate-x-1/2 cursor-ns-resize",
  sw: "-bottom-[5px] -left-[5px] cursor-nesw-resize",
  w: "top-1/2 -left-[5px] -translate-y-1/2 cursor-ew-resize",
};

interface Session {
  id: string;
  handle: Handle | null; // null = move
  startX: number;
  startY: number;
  start: Rect;
  moved: boolean;
  /** already selected at pointer-down: a plain click then means "edit" */
  wasSelected: boolean;
}

function MiniButton({ label, onClick, icon: Icon, danger }: {
  label: string;
  onClick: () => void;
  icon: typeof Copy;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onClick}
      className={cn(
        "flex h-7 w-7 cursor-pointer items-center justify-center rounded-md transition-colors",
        danger ? "text-ink-muted hover:bg-status-critical/10 hover:text-status-critical" : "text-ink-muted hover:bg-surface-raised hover:text-ink-primary"
      )}
    >
      <Icon size={14} />
    </button>
  );
}

/**
 * The report page: a fixed-size canvas (page px) drawn at a zoom inside a
 * scrollable workspace. Owns all direct manipulation -- select, drag,
 * 8-handle resize, smart-guide/grid snapping, keyboard nudge -- and draws
 * selection chrome in an overlay layer ABOVE every visual, so handles and
 * toolbars are never buried under a higher-z neighbour.
 */
export function ReportCanvas({
  page,
  items,
  editMode,
  zoom,
  selectedId,
  editingId,
  onSelect,
  onEditText,
  onCommitLayout,
  onTextInput,
  onConfig,
  onDuplicate,
  onDelete,
  onArrange,
  onFocusVisual,
  onScale,
  onEditor,
}: {
  page: ReportPage;
  items: DashboardItem[];
  editMode: boolean;
  zoom: Zoom;
  selectedId: string | null;
  editingId: string | null;
  onSelect: (id: string | null) => void;
  onEditText: (id: string | null) => void;
  onCommitLayout: (id: string, rect: Rect) => void;
  onTextInput: (id: string, html: string) => void;
  onConfig: (id: string, config: TileConfig) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onArrange: (id: string, dir: "front" | "back") => void;
  onFocusVisual: (id: string) => void;
  onScale: (scale: number) => void;
  /** the live contentEditable of the box being edited (or null) */
  onEditor?: (el: HTMLDivElement | null) => void;
}) {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [live, setLive] = useState<{ id: string; rect: Rect } | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [editor, setEditor] = useState<HTMLDivElement | null>(null);
  const session = useRef<Session | null>(null);
  // The live rect is mirrored in a ref so pointerup can commit it WITHOUT
  // a side effect inside a setState updater (StrictMode double-invokes
  // updaters -- that would save every drag twice).
  const liveRef = useRef<{ id: string; rect: Rect } | null>(null);
  const itemsRef = useRef(items);
  const selectedIdRef = useRef(selectedId);
  useEffect(() => {
    itemsRef.current = items;
    selectedIdRef.current = selectedId;
  }, [items, selectedId]);

  useEffect(() => onEditor?.(editor), [editor, onEditor]);

  /** Grow a text box to fit its content (never past the page bottom). */
  const onGrow = useCallback(
    (id: string, height: number) => {
      const item = itemsRef.current.find((i) => i.id === id);
      if (!item) return;
      const h = Math.min(Math.ceil(height / 8) * 8, page.height - item.layout.y);
      if (h > item.layout.h) onCommitLayout(id, { ...item.layout, h });
    },
    [page.height, onCommitLayout]
  );

  // The workspace's size is set by the page layout (flex), never by the
  // canvas inside it (overflow: auto), so observing it can't feed back on
  // itself -- unlike the Phase 7 tile-observer loop.
  useLayoutEffect(() => {
    const el = workspaceRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pad = editMode ? 48 : 24;
  const fit = box.w ? Math.max(0.1, Math.min((box.w - pad * 2) / page.width, (box.h - pad * 2) / page.height)) : 0;
  const scale = zoom === "fit" ? fit : zoom;

  useEffect(() => {
    if (scale) onScale(scale);
  }, [scale, onScale]);

  const pageBounds = { w: page.width, h: page.height };

  const begin = useCallback(
    (e: ReactPointerEvent, id: string, handle: Handle | null) => {
      if (!editMode || e.button !== 0) return;
      const target = e.target as HTMLElement;
      e.stopPropagation(); // never let the page underneath deselect it
      if (editingId === id && target.closest(".no-drag")) return; // typing / selecting text
      const item = itemsRef.current.find((i) => i.id === id);
      if (!item) return;
      if (editingId && editingId !== id) onEditText(null);
      const wasSelected = selectedIdRef.current === id;
      onSelect(id);
      if (editingId === id && !handle) return;
      session.current = {
        id,
        handle,
        startX: e.clientX,
        startY: e.clientY,
        start: { ...item.layout },
        moved: false,
        wasSelected,
      };
    },
    [editMode, editingId, onEditText, onSelect]
  );

  const onItemPointerDown = useCallback((e: ReactPointerEvent, id: string) => begin(e, id, null), [begin]);

  useEffect(() => {
    function move(e: PointerEvent) {
      const s = session.current;
      if (!s) return;
      const dx = (e.clientX - s.startX) / scale;
      const dy = (e.clientY - s.startY) / scale;
      if (!s.moved && Math.hypot(dx * scale, dy * scale) < 3) return;
      s.moved = true;
      const others = itemsRef.current.filter((i) => i.id !== s.id).map((i) => i.layout);
      const res = s.handle
        ? snapResize(s.start, s.handle, dx, dy, others, pageBounds, scale)
        : snapMove({ ...s.start, x: s.start.x + dx, y: s.start.y + dy }, others, pageBounds, scale);
      liveRef.current = { id: s.id, rect: res.rect };
      setLive(liveRef.current);
      setGuides(res.guides);
    }
    function up(e: PointerEvent) {
      const s = session.current;
      const cur = liveRef.current;
      session.current = null;
      liveRef.current = null;
      if (s?.moved && cur && cur.id === s.id) onCommitLayout(s.id, cur.rect);
      // Click (no drag) on a text box that was ALREADY selected = start
      // typing right there, like PowerPoint/Power BI. The first click only
      // selects, so a text box can still be dragged without editing it.
      if (s && !s.moved && !s.handle && s.wasSelected) {
        const item = itemsRef.current.find((i) => i.id === s.id);
        if (item?.kind === "text") {
          setCaretPoint(e.clientX, e.clientY);
          onEditText(s.id);
        }
      }
      setGuides([]);
      setLive(null);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [scale, page.width, page.height, onCommitLayout, onEditText]); // eslint-disable-line react-hooks/exhaustive-deps

  // keyboard: nudge, delete, duplicate, escape
  useEffect(() => {
    if (!editMode) return;
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))) {
        if (e.key === "Escape" && editingId) {
          (el as HTMLElement).blur();
          onEditText(null);
        }
        return;
      }
      if (!selectedId) return;
      const item = itemsRef.current.find((i) => i.id === selectedId);
      if (!item) return;
      if (e.key === "Escape") onSelect(null);
      else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        onDelete(selectedId);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        onDuplicate(selectedId);
      } else if (e.key === "Enter" && item.kind === "text") {
        e.preventDefault();
        onEditText(selectedId);
      } else if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        const step = e.shiftKey ? 8 : 1;
        const { x, y, w, h } = item.layout;
        const nx = e.key === "ArrowLeft" ? x - step : e.key === "ArrowRight" ? x + step : x;
        const ny = e.key === "ArrowUp" ? y - step : e.key === "ArrowDown" ? y + step : y;
        onCommitLayout(selectedId, {
          x: Math.max(0, Math.min(page.width - w, nx)),
          y: Math.max(0, Math.min(page.height - h, ny)),
          w,
          h,
        });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editMode, selectedId, editingId, page.width, page.height, onCommitLayout, onDelete, onDuplicate, onEditText, onSelect]);

  const selected = items.find((i) => i.id === selectedId) ?? null;
  const selRect = selected ? (live?.id === selected.id ? live.rect : selected.layout) : null;
  const pageW = page.width * scale;
  const pageH = page.height * scale;

  return (
    <div
      ref={workspaceRef}
      className="workspace relative min-h-0 flex-1 overflow-auto"
      onPointerDown={() => {
        if (editingId) onEditText(null);
        onSelect(null);
      }}
    >
      {scale > 0 && (
        <div
          className="relative mx-auto"
          style={{ width: pageW + pad * 2, height: pageH + pad * 2, padding: pad, minWidth: "100%" }}
        >
          <div
            data-testid="report-page"
            className="relative mx-auto rounded-[6px] shadow-[0_1px_2px_rgba(0,0,0,0.2),0_24px_60px_-20px_rgba(0,0,0,0.45)] ring-1 ring-border"
            style={{
              width: pageW,
              height: pageH,
              background: page.background ?? "var(--surface)",
              backgroundImage: editMode
                ? `radial-gradient(color-mix(in oklab, var(--ink-muted) 22%, transparent) 1px, transparent 1px)`
                : undefined,
              backgroundSize: editMode ? `${16 * scale}px ${16 * scale}px` : undefined,
            }}
            onPointerDown={(e) => {
              e.stopPropagation();
              if (editingId) onEditText(null);
              onSelect(null);
            }}
          >
            {items.map((item) => (
              <CanvasItem
                key={item.id}
                item={item}
                live={live?.id === item.id ? live.rect : undefined}
                scale={scale}
                editMode={editMode}
                selected={selectedId === item.id}
                editingText={editingId === item.id}
                onPointerDown={onItemPointerDown}
                onDoubleClick={onEditText}
                onEditorMount={setEditor}
                onTextInput={onTextInput}
                onGrow={onGrow}
                onFocusVisual={onFocusVisual}
              />
            ))}

            {/* overlay: guides + selection chrome, above every visual */}
            <div className="pointer-events-none absolute inset-0" style={{ zIndex: 100000 }}>
              {guides.map((g, i) =>
                g.axis === "x" ? (
                  <span
                    key={i}
                    className="absolute w-px bg-[#ff2d87]"
                    style={{ left: g.pos * scale, top: g.from * scale, height: (g.to - g.from) * scale }}
                  />
                ) : (
                  <span
                    key={i}
                    className="absolute h-px bg-[#ff2d87]"
                    style={{ top: g.pos * scale, left: g.from * scale, width: (g.to - g.from) * scale }}
                  />
                )
              )}

              {editMode && selected && selRect && (
                <div
                  className="absolute outline outline-2 outline-accent"
                  style={{ left: selRect.x * scale, top: selRect.y * scale, width: selRect.w * scale, height: selRect.h * scale }}
                >
                  {!live &&
                    HANDLES.map((h) => (
                      <span
                        key={h}
                        data-handle={h}
                        onPointerDown={(e) => begin(e, selected.id, h)}
                        className={cn(
                          "pointer-events-auto absolute h-[10px] w-[10px] rounded-[3px] border-2 border-accent bg-plane",
                          HANDLE_POS[h]
                        )}
                      />
                    ))}

                  {live && (
                    <span className="absolute -bottom-7 left-0 rounded-md bg-accent px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-accent-ink tabular-nums">
                      {Math.round(selRect.x)}, {Math.round(selRect.y)} · {Math.round(selRect.w)} × {Math.round(selRect.h)}
                    </span>
                  )}

                  {!live && (
                    <div
                      className={cn(
                        "pointer-events-auto absolute",
                        // Always ABOVE the visual -- the workspace keeps padding
                        // above the page, so even a visual at y=0 has room, and
                        // the bar never covers the content it's acting on
                        // (real bug: it sat over a top-of-page heading).
                        "bottom-full mb-2",
                        editingId === selected.id
                          ? // the text toolbar is ~600px wide: anchor it to
                            // whichever side keeps it on the page
                            selRect.x * scale + 600 > pageW
                            ? "right-0"
                            : "left-0"
                          : "right-0"
                      )}
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      {editingId === selected.id ? (
                        <TextToolbar item={selected} editor={editor} onConfig={(c) => onConfig(selected.id, c)} />
                      ) : (
                        <div className="panel flex items-center gap-0.5 rounded-xl p-0.5" role="toolbar" aria-label="Visual actions">
                          {selected.kind === "text" && (
                            <MiniButton label="Edit text" icon={Pencil} onClick={() => onEditText(selected.id)} />
                          )}
                          <MiniButton label="Duplicate" icon={Copy} onClick={() => onDuplicate(selected.id)} />
                          <MiniButton label="Bring to front" icon={ArrowUpToLine} onClick={() => onArrange(selected.id, "front")} />
                          <MiniButton label="Send to back" icon={ArrowDownToLine} onClick={() => onArrange(selected.id, "back")} />
                          <MiniButton label="Delete" icon={Trash2} danger onClick={() => onDelete(selected.id)} />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
