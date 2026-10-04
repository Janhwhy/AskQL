"use client";

import { ArrowRight } from "lucide-react";

/**
 * The project's actual differentiator (CLAUDE.md): when 2+ metrics
 * plausibly match, ask instead of guessing. Candidates are shown as
 * readable labels (not raw snake_case metric names) but the click sends
 * the label text as the clarification_answer — agent/graph.py resolves it
 * back to a metric with a deterministic keyword match, not by expecting an
 * exact metric-name string back.
 */
function humanize(metricName: string): string {
  return metricName.replace(/_/g, " ");
}

export function ClarificationChips({
  question,
  candidates,
  onPick,
  disabled,
}: {
  question: string;
  candidates: string[];
  onPick: (answer: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <span className="kicker flex items-center gap-2 !text-accent">
          <span className="animate-pulse-ring h-1.5 w-1.5 rounded-full bg-accent" />
          Before I guess — which one?
        </span>
        <p className="font-display text-[1.45rem] leading-snug text-ink-primary">{question}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {candidates.map((c) => (
          <button
            key={c}
            disabled={disabled}
            onClick={() => onPick(humanize(c))}
            className="group flex cursor-pointer items-center gap-2 rounded-full border border-border-strong bg-surface-raised px-4 py-2 text-[13.5px] text-ink-primary capitalize transition-all hover:border-accent hover:bg-accent-wash disabled:cursor-not-allowed disabled:opacity-50"
          >
            {humanize(c)}
            <ArrowRight size={13} className="text-ink-muted transition-transform group-hover:translate-x-0.5 group-hover:text-accent" />
          </button>
        ))}
      </div>
      <p className="text-xs text-ink-muted">Your choice is remembered for the rest of this chat.</p>
    </div>
  );
}
