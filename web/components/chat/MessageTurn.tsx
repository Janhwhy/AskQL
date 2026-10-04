"use client";

import { AlertCircle } from "lucide-react";
import type { Turn } from "@/lib/types";
import { ChartRenderer } from "./ChartRenderer";
import { ClarificationChips } from "./ClarificationChips";
import { PinButton } from "./PinButton";
import { SqlButton } from "./SqlButton";
import { StageIndicator } from "./StageIndicator";

/** Insight sentence, revealed word by word -- only for an answer that just
 * arrived; a reopened chat shows its text immediately. */
function Narration({ text, animate }: { text: string; animate: boolean }) {
  if (!animate) return <>{text}</>;
  return (
    <>
      {text.split(/(\s+)/).map((w, i) =>
        /^\s+$/.test(w) ? (
          w
        ) : (
          <span key={i} className="animate-word inline-block" style={{ animationDelay: `${Math.min(i, 80) * 18}ms` }}>
            {w}
          </span>
        )
      )}
    </>
  );
}

/**
 * One question + its answer, laid out like an entry in a notebook rather
 * than a chat bubble: an index, the question set as a headline, and the
 * answer as a readout beneath it.
 */
export function MessageTurn({
  turn,
  index,
  onClarify,
  disabled,
}: {
  turn: Turn;
  index: number;
  onClarify: (answer: string) => void;
  disabled?: boolean;
}) {
  const fresh = turn.fresh === true;
  return (
    <article className="animate-rise flex flex-col gap-5" data-testid="turn">
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <span className="kicker !text-accent">Q{index}</span>
          <span className="h-px flex-1 bg-gradient-to-r from-border-strong to-transparent" />
        </div>
        <h2 className="font-display text-[clamp(1.45rem,2.8vw,1.9rem)] leading-[1.15] text-ink-primary">
          {turn.question}
        </h2>
      </header>

      <div className="panel relative rounded-[22px] px-5 py-5 sm:px-7 sm:py-6">
        {turn.status === "streaming" && turn.stage && (
          <StageIndicator stage={turn.stage} sql={turn.sql} retried={turn.retried} />
        )}

        {turn.status === "clarification" && turn.clarification && (
          <ClarificationChips
            question={turn.clarification.question}
            candidates={turn.clarification.candidates}
            onPick={onClarify}
            disabled={disabled}
          />
        )}

        {turn.status === "error" && (
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3 text-[14.5px] text-ink-primary">
              <AlertCircle size={18} className="mt-0.5 shrink-0 text-status-critical" />
              <div className="flex flex-col gap-1">
                <span className="kicker !text-status-critical">Couldn&apos;t answer</span>
                <span>{turn.error}</span>
              </div>
            </div>
            {turn.sql && <SqlButton sql={turn.sql} />}
          </div>
        )}

        {turn.status === "done" && (
          <div className="flex flex-col gap-5">
            <div className="flex items-start justify-between gap-4">
              {turn.narration ? (
                <p className="max-w-[62ch] text-[17px] leading-relaxed text-ink-primary">
                  <Narration text={turn.narration} animate={fresh} />
                </p>
              ) : (
                <span />
              )}
              <div className="flex shrink-0 items-center gap-1.5">
                {turn.sql && <SqlButton sql={turn.sql} />}
                {turn.chart && turn.sql && (
                  <PinButton question={turn.question} sql={turn.sql} chart={turn.chart} narration={turn.narration} />
                )}
              </div>
            </div>
            {turn.chart && turn.rows && turn.columns && (
              <div className={fresh ? "animate-wipe -mx-1" : "-mx-1"}>
                <ChartRenderer chart={turn.chart} rows={turn.rows} columns={turn.columns} />
              </div>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
