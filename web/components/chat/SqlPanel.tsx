"use client";

import { useState } from "react";
import { ChevronRight, Code2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The "trust mechanics" surface — CLAUDE.md: "Every response returns the
 * SQL used... Trust mechanics are a feature, not debug output." Collapsed
 * by default so it doesn't clutter the answer, but one click away, always.
 */
export function SqlPanel({ sql }: { sql: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-3 border-t border-border pt-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-ink-muted transition-colors hover:text-ink-secondary cursor-pointer"
      >
        <ChevronRight
          size={13}
          className={cn("transition-transform duration-200", open && "rotate-90")}
        />
        <Code2 size={13} />
        <span>{open ? "Hide SQL" : "View SQL"}</span>
      </button>
      {open && (
        <pre className="animate-fade-up mt-2 overflow-x-auto rounded-lg border border-border bg-plane px-3 py-2.5 font-mono text-[12px] leading-relaxed text-ink-secondary">
          {sql}
        </pre>
      )}
    </div>
  );
}
