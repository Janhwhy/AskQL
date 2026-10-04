"use client";

import { Minimize2 } from "lucide-react";
import { useEffect } from "react";
import type { DashboardItem } from "@/lib/types";
import { ChartVisual } from "./ChartVisual";

/** Power BI "focus mode": one visual, filling the screen. */
export function FocusModal({ item, onClose }: { item: DashboardItem; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="animate-fade-up fixed inset-0 z-[200] flex items-center justify-center bg-black/55 p-6 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Focus mode"
    >
      <div
        className="panel relative flex h-[min(82vh,900px)] w-[min(92vw,1500px)] flex-col rounded-[24px] p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          aria-label="Back to report"
          className="absolute top-4 right-4 z-10 flex cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-surface-raised px-2.5 py-1.5 text-[12.5px] text-ink-secondary hover:text-ink-primary"
        >
          <Minimize2 size={13} /> Back to report
        </button>
        <ChartVisual item={item} />
      </div>
    </div>
  );
}
