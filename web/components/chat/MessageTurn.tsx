"use client";

import { AlertCircle } from "lucide-react";
import type { Turn } from "@/lib/types";
import { ChartRenderer } from "./ChartRenderer";
import { ClarificationChips } from "./ClarificationChips";
import { PinButton } from "./PinButton";
import { SqlPanel } from "./SqlPanel";
import { StageIndicator } from "./StageIndicator";

export function MessageTurn({
  turn,
  onClarify,
}: {
  turn: Turn;
  onClarify: (answer: string) => void;
}) {
  return (
    <div className="animate-fade-up flex flex-col gap-3">
      {/* the question */}
      <div className="flex justify-end">
        <div className="max-w-[75%] rounded-2xl rounded-br-sm bg-accent px-4 py-2.5 text-[15px] text-accent-ink">
          {turn.question}
        </div>
      </div>

      {/* the answer */}
      <div className="flex justify-start">
        <div className="w-full max-w-[85%] rounded-2xl rounded-bl-sm border border-border bg-surface px-5 py-4">
          {turn.status === "streaming" && (
            <StageIndicator label={turn.stageLabel ?? "Thinking…"} />
          )}

          {turn.retried && turn.status === "streaming" && (
            <p className="mb-1 text-xs text-status-warning">
              First attempt hit an error — retrying once…
            </p>
          )}

          {turn.status === "clarification" && turn.clarification && (
            <ClarificationChips
              question={turn.clarification.question}
              candidates={turn.clarification.candidates}
              onPick={onClarify}
            />
          )}

          {turn.status === "error" && (
            <div className="flex items-start gap-2 text-sm text-ink-primary">
              <AlertCircle size={16} className="mt-0.5 shrink-0 text-status-critical" />
              <span>{turn.error}</span>
            </div>
          )}

          {turn.status === "done" && (
            <div className="flex flex-col gap-1">
              {turn.narration && (
                <p className="text-[15px] leading-relaxed text-ink-primary">{turn.narration}</p>
              )}
              {turn.chart && turn.rows && turn.columns && (
                <div className="mt-2">
                  <ChartRenderer chart={turn.chart} rows={turn.rows} columns={turn.columns} />
                </div>
              )}
              {turn.chart && turn.sql && (
                <div className="mt-2 flex justify-end">
                  <PinButton
                    question={turn.question}
                    sql={turn.sql}
                    chart={turn.chart}
                    narration={turn.narration}
                  />
                </div>
              )}
              {turn.sql && <SqlPanel sql={turn.sql} />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
