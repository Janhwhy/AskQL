"use client";

import { MessageCircleQuestion } from "lucide-react";

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
    <div className="flex flex-col gap-2.5">
      <div className="flex items-start gap-2 text-sm text-ink-primary">
        <MessageCircleQuestion size={16} className="mt-0.5 shrink-0 text-accent" />
        <span>{question}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {candidates.map((c) => (
          <button
            key={c}
            disabled={disabled}
            onClick={() => onPick(humanize(c))}
            className="cursor-pointer rounded-full border border-border-strong bg-surface px-3.5 py-1.5 text-sm text-ink-primary capitalize transition-colors hover:border-accent hover:bg-accent-wash disabled:cursor-not-allowed disabled:opacity-50"
          >
            {humanize(c)}
          </button>
        ))}
      </div>
    </div>
  );
}
