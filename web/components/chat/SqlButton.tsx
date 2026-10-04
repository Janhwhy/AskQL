"use client";

import { Check, Code2, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * The "trust mechanics" surface — CLAUDE.md: "Every response returns the
 * SQL used... Trust mechanics are a feature, not debug output." Phase 8b
 * took it off the answer's own row (it read as clutter) into one quiet icon
 * beside Pin: the exact query is still one click away on every answer.
 */
export function SqlButton({ sql, align = "right" }: { sql: string; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(sql);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // clipboard blocked -- the SQL is still selectable
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Show SQL"
        aria-expanded={open}
        title="Show the SQL behind this answer"
        className={cn(
          "flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border transition-colors",
          open
            ? "border-accent bg-accent-wash text-accent"
            : "border-border-strong bg-surface-raised text-ink-muted hover:border-accent hover:text-ink-primary"
        )}
      >
        <Code2 size={14} />
      </button>
      {open && (
        <div
          className={cn(
            "animate-fade-up panel absolute top-full z-30 mt-2 w-[min(560px,80vw)] rounded-2xl p-1.5",
            align === "right" ? "right-0" : "left-0"
          )}
        >
          <div className="flex items-center justify-between px-2.5 pt-1.5 pb-2">
            <span className="kicker">The query behind this answer</span>
            <button
              onClick={copy}
              aria-label="Copy SQL"
              className="flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] text-ink-muted transition-colors hover:text-ink-primary"
            >
              {copied ? <Check size={12} className="text-status-good" /> : <Copy size={12} />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <pre className="max-h-64 overflow-auto rounded-xl bg-sunken px-3.5 py-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-ink-secondary">
            {sql}
          </pre>
        </div>
      )}
    </div>
  );
}
