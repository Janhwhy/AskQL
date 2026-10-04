"use client";

import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import type { StageKey } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The agent's real pipeline, step by step -- each step lights up as the
 * matching SSE event actually arrives from the graph (agent/graph.py's
 * ask_stream), so this is genuine progress, not a fake typing effect.
 * Under it: a live elapsed timer, the SQL typing itself out the moment it
 * exists, and a skeleton of the answer that's coming.
 */
const STEPS = ["Choosing the metric", "Running the query", "Shaping the chart", "Writing the insight"];

// stage event received -> index of the step now IN PROGRESS
const ACTIVE: Record<StageKey, number> = {
  thinking: 0,
  sql: 1,
  retrying: 1,
  result: 2,
  chart: 3,
  narration: 3,
};

function useElapsed() {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, []);
  return (now - start) / 1000;
}

/** Types the SQL out, fast -- it already exists, this just makes its
 * arrival legible instead of a block popping in. */
function useTypewriter(text: string | null, cps = 900) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (!text) return;
    const started = performance.now();
    let raf = 0;
    const tick = () => {
      const n = Math.min(text.length, Math.floor(((performance.now() - started) / 1000) * cps));
      setShown(n);
      if (n < text.length) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, cps]);
  return text ? text.slice(0, shown) : "";
}

export function StageIndicator({ stage, sql, retried }: { stage: StageKey; sql: string | null; retried: boolean }) {
  const active = ACTIVE[stage];
  const elapsed = useElapsed();
  const typed = useTypewriter(sql);

  return (
    <div className="flex flex-col gap-5" role="status" aria-live="polite" aria-label={STEPS[active]}>
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2.5 text-[14px] text-ink-primary">
          <span className="relative flex h-2.5 w-2.5">
            <span className="beam-gradient absolute inset-0 animate-ping rounded-full opacity-60" />
            <span className="beam-gradient relative h-2.5 w-2.5 rounded-full" />
          </span>
          <span key={active} className="animate-fade-up">
            {STEPS[active]}…
          </span>
        </span>
        <span className="text-[12px] tabular-nums text-ink-muted">{elapsed.toFixed(1)}s</span>
      </div>

      <ol className="grid grid-cols-4 gap-2">
        {STEPS.map((label, i) => {
          const done = i < active;
          const current = i === active;
          return (
            <li key={label} className="flex flex-col gap-2">
              <span className={cn("relative h-[3px] overflow-hidden rounded-full bg-border", current && "shimmer")}>
                <span
                  className={cn(
                    "beam-gradient absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ease-out",
                    done ? "w-full" : current ? "w-[55%] shadow-[0_0_10px_var(--glow)]" : "w-0"
                  )}
                />
              </span>
              <span
                className={cn(
                  "hidden items-center gap-1.5 text-[11.5px] transition-colors sm:flex",
                  done ? "text-ink-secondary" : current ? "text-ink-primary" : "text-ink-muted/70"
                )}
              >
                {done && <Check size={11} className="text-accent" />}
                {label}
              </span>
            </li>
          );
        })}
      </ol>

      {retried && stage === "retrying" && (
        <p className="animate-fade-up text-xs text-status-warning">
          First attempt hit an error — correcting and retrying once…
        </p>
      )}

      {sql && (
        <pre className="animate-fade-up max-h-24 overflow-hidden font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink-muted [mask-image:linear-gradient(to_bottom,black_45%,transparent)]">
          {typed}
          {typed.length < sql.length && <span className="ml-px inline-block h-3 w-[6px] translate-y-0.5 bg-accent" />}
        </pre>
      )}

      {/* the shape of the answer that's coming */}
      <div className="flex flex-col gap-3" aria-hidden="true">
        <span className="shimmer h-3.5 w-[72%] rounded-full bg-border/70" />
        <span className="shimmer h-3.5 w-[48%] rounded-full bg-border/70" />
        <div className="shimmer relative mt-1 h-36 overflow-hidden rounded-2xl bg-border/40">
          <svg viewBox="0 0 400 120" preserveAspectRatio="none" className="absolute inset-0 h-full w-full opacity-40">
            <path
              d="M0 95 C 40 80, 70 40, 110 52 S 180 98, 220 70 S 300 20, 340 38 S 390 60, 400 50"
              fill="none"
              stroke="var(--ink-muted)"
              strokeWidth="2"
              strokeDasharray="6 6"
            />
          </svg>
        </div>
      </div>
    </div>
  );
}
