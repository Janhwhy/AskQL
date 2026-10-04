"use client";

import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpToLine,
  Copy,
  Eye,
  Maximize,
  Minus,
  PencilRuler,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Type,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AskToAdd } from "@/components/dashboards/AskToAdd";
import type { DashboardItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { Zoom } from "./ReportCanvas";

function Tool({ label, icon: Icon, onClick, disabled, active, wide }: {
  label: string;
  icon: typeof Type;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  wide?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        "flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-lg text-[12.5px] whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-35",
        wide ? "px-2.5" : "w-9",
        active ? "bg-accent-wash text-accent" : "text-ink-secondary hover:bg-surface-raised hover:text-ink-primary disabled:hover:bg-transparent"
      )}
    >
      <Icon size={15} />
      {wide && <span>{label}</span>}
    </button>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-0.5 border-r border-border px-2 last:border-r-0" role="group" aria-label={label}>
      <div className="flex items-center gap-0.5">{children}</div>
      <span className="text-[9.5px] font-medium tracking-[0.1em] text-ink-muted uppercase">{label}</span>
    </div>
  );
}

/** The report's command bar: Power BI's ribbon, cut down to what this
 * editor actually does. */
export function Ribbon({
  dashboardId,
  pageId,
  name,
  onRename,
  editMode,
  onMode,
  selected,
  onAddText,
  onVisualAdded,
  onDuplicate,
  onDelete,
  onArrange,
  zoom,
  scale,
  onZoom,
  onRefresh,
  refreshing,
}: {
  dashboardId: string;
  pageId: string;
  name: string;
  onRename: (name: string) => void;
  editMode: boolean;
  onMode: (edit: boolean) => void;
  selected: DashboardItem | null;
  onAddText: () => void;
  onVisualAdded: (item: DashboardItem) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onArrange: (dir: "front" | "back") => void;
  zoom: Zoom;
  scale: number;
  onZoom: (z: Zoom) => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [askOpen, setAskOpen] = useState(false);
  const askRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!askOpen) return;
    function onDown(e: MouseEvent) {
      if (askRef.current && !askRef.current.contains(e.target as Node)) setAskOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [askOpen]);

  const pct = Math.round(scale * 100);
  const stepZoom = (dir: 1 | -1) => {
    const steps = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2];
    const next = dir > 0 ? steps.find((s) => s > scale + 0.001) : [...steps].reverse().find((s) => s < scale - 0.001);
    onZoom(next ?? (dir > 0 ? 2 : 0.25));
  };

  return (
    <header className="relative z-30 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-surface/80 px-3 py-2 backdrop-blur-xl">
      <div className="flex min-w-0 items-center gap-2">
        <Link
          href="/dashboards"
          aria-label="All dashboards"
          title="All dashboards"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-muted hover:bg-surface-raised hover:text-ink-primary"
        >
          <ArrowLeft size={16} />
        </Link>
        {editMode ? (
          <input
            aria-label="Dashboard name"
            defaultValue={name}
            key={name}
            onBlur={(e) => e.target.value.trim() && e.target.value !== name && onRename(e.target.value.trim())}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            className="w-[min(320px,40vw)] rounded-lg border border-transparent bg-transparent px-2 py-1 text-[16px] font-semibold tracking-tight text-ink-primary outline-none hover:border-border focus:border-accent"
          />
        ) : (
          <h1 className="truncate px-2 text-[16px] font-semibold tracking-tight text-ink-primary">{name}</h1>
        )}
        <span className="hidden items-center gap-1.5 text-[11.5px] text-ink-muted sm:flex">
          <span className="h-1.5 w-1.5 rounded-full bg-status-good shadow-[0_0_6px_var(--status-good)]" />
          Live
        </span>
      </div>

      {editMode && (
        <div className="order-3 flex w-full items-stretch overflow-x-auto lg:order-none lg:w-auto lg:flex-1 lg:justify-center">
          <Group label="Insert">
            <Tool label="Text box" icon={Type} onClick={onAddText} wide />
            <div ref={askRef} className="relative">
              <Tool label="Ask a visual" icon={Sparkles} onClick={() => setAskOpen((v) => !v)} active={askOpen} wide />
              {askOpen && (
                <div className="panel animate-fade-up absolute top-full left-1/2 z-40 mt-2 w-[min(520px,90vw)] -translate-x-1/2 rounded-2xl p-3">
                  <p className="mb-2 px-1 text-[12px] text-ink-muted">
                    Ask in plain English — the answer lands on this page as a new visual.
                  </p>
                  <AskToAdd
                    dashboardId={dashboardId}
                    pageId={pageId}
                    onAdded={(item) => {
                      onVisualAdded(item);
                      setAskOpen(false);
                    }}
                  />
                </div>
              )}
            </div>
          </Group>
          <Group label="Arrange">
            <Tool label="Bring to front" icon={ArrowUpToLine} onClick={() => onArrange("front")} disabled={!selected} />
            <Tool label="Send to back" icon={ArrowDownToLine} onClick={() => onArrange("back")} disabled={!selected} />
            <Tool label="Duplicate" icon={Copy} onClick={onDuplicate} disabled={!selected} />
            <Tool label="Delete" icon={Trash2} onClick={onDelete} disabled={!selected} />
          </Group>
          <Group label="Zoom">
            <Tool label="Zoom out" icon={Minus} onClick={() => stepZoom(-1)} />
            <button
              onClick={() => onZoom(1)}
              title="Actual size"
              className="h-9 w-12 cursor-pointer rounded-lg text-[12.5px] tabular-nums text-ink-secondary hover:bg-surface-raised hover:text-ink-primary"
            >
              {pct}%
            </button>
            <Tool label="Zoom in" icon={Plus} onClick={() => stepZoom(1)} />
            <Tool label="Fit to page" icon={Maximize} onClick={() => onZoom("fit")} active={zoom === "fit"} />
          </Group>
        </div>
      )}

      <div className="ml-auto flex items-center gap-1.5">
        <button
          onClick={onRefresh}
          disabled={refreshing}
          aria-label="Refresh"
          title="Re-run every visual's query"
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-ink-secondary hover:bg-surface-raised hover:text-ink-primary disabled:cursor-not-allowed"
        >
          <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
        </button>
        <div className="flex rounded-lg border border-border bg-sunken p-0.5" role="group" aria-label="Mode">
          {(
            [
              [false, "View", Eye],
              [true, "Edit", PencilRuler],
            ] as const
          ).map(([mode, label, Icon]) => (
            <button
              key={label}
              onClick={() => onMode(mode)}
              aria-pressed={editMode === mode}
              className={cn(
                "flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-[12.5px] transition-colors",
                editMode === mode ? "bg-surface-raised text-ink-primary shadow-sm" : "text-ink-muted hover:text-ink-primary"
              )}
            >
              <Icon size={13} className={editMode === mode ? "text-accent" : ""} />
              {label}
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}
