"use client";

import { Plus, X } from "lucide-react";
import { useState } from "react";
import type { ReportPage } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Report page tabs along the bottom, Power BI style. Double-click a tab
 * to rename it (Edit mode). */
export function PageTabs({
  pages,
  activeId,
  editMode,
  onSelect,
  onAdd,
  onRename,
  onDelete,
}: {
  pages: ReportPage[];
  activeId: string;
  editMode: boolean;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  return (
    <nav
      aria-label="Report pages"
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-border bg-surface/80 px-3 py-1.5 backdrop-blur-xl"
    >
      {pages.map((p) => {
        const active = p.id === activeId;
        if (renaming === p.id) {
          return (
            <input
              key={p.id}
              autoFocus
              aria-label="Page name"
              defaultValue={p.name}
              onBlur={(e) => {
                setRenaming(null);
                if (e.target.value.trim() && e.target.value !== p.name) onRename(p.id, e.target.value.trim());
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setRenaming(null);
              }}
              className="h-8 w-36 rounded-lg border border-accent bg-sunken px-2.5 text-[12.5px] text-ink-primary outline-none"
            />
          );
        }
        return (
          <div key={p.id} className="group relative flex items-center">
            <button
              role="tab"
              aria-selected={active}
              onClick={() => onSelect(p.id)}
              onDoubleClick={() => editMode && setRenaming(p.id)}
              className={cn(
                "relative h-8 cursor-pointer rounded-lg px-3 text-[12.5px] whitespace-nowrap transition-colors",
                editMode && pages.length > 1 && "pr-7",
                active ? "bg-surface-raised font-medium text-ink-primary" : "text-ink-muted hover:bg-surface-raised/60 hover:text-ink-primary"
              )}
            >
              {p.name}
              {active && <span className="beam-gradient absolute inset-x-2.5 -bottom-1.5 h-[2px] rounded-full" />}
            </button>
            {editMode && pages.length > 1 && (
              <button
                aria-label={`Delete page ${p.name}`}
                onClick={() => setConfirming(p.id)}
                className="absolute right-1.5 flex h-5 w-5 cursor-pointer items-center justify-center rounded text-ink-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-status-critical"
              >
                <X size={12} />
              </button>
            )}
            {confirming === p.id && (
              <div className="panel animate-fade-up absolute bottom-full left-0 z-40 mb-2 flex w-56 flex-col gap-2 rounded-xl p-3">
                <p className="text-[12px] text-ink-secondary">Delete “{p.name}” and every visual on it?</p>
                <div className="flex gap-1.5">
                  <button
                    onClick={() => {
                      setConfirming(null);
                      onDelete(p.id);
                    }}
                    className="flex-1 cursor-pointer rounded-md bg-status-critical px-2 py-1 text-xs font-medium text-white"
                  >
                    Delete page
                  </button>
                  <button
                    onClick={() => setConfirming(null)}
                    className="flex-1 cursor-pointer rounded-md border border-border px-2 py-1 text-xs text-ink-secondary"
                  >
                    Keep
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
      {editMode && (
        <button
          onClick={onAdd}
          aria-label="New page"
          title="New page"
          className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-ink-muted hover:bg-surface-raised hover:text-ink-primary"
        >
          <Plus size={15} />
        </button>
      )}
    </nav>
  );
}
