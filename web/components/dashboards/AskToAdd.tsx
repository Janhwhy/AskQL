"use client";

import { ArrowUp, Sparkles } from "lucide-react";
import { useRef, useState } from "react";
import { ClarificationChips } from "@/components/chat/ClarificationChips";
import { streamChat } from "@/lib/api";
import { pinChart } from "@/lib/dashboardApi";
import type { ChartDecision, DashboardItem } from "@/lib/types";

type Phase =
  | { kind: "idle" }
  | { kind: "working"; label: string }
  | { kind: "clarify"; question: string; candidates: string[]; original: string }
  | { kind: "error"; message: string };

const LABELS: Record<string, string> = {
  thinking: "Choosing the metric…",
  sql: "Running the query…",
  retrying: "Correcting and retrying once…",
  result: "Shaping the chart…",
  chart: "Writing the insight…",
  narration: "Placing the tile…",
};

/**
 * Ask a question right on the dashboard and get the answer as a new tile --
 * the same agent, same governed metrics, same SQL validation on pin, just
 * without a detour through the chat. `save: false` keeps a thread (so an
 * ambiguity question can still round-trip) without filing it as a chat.
 */
export function AskToAdd({
  dashboardId,
  pageId,
  onAdded,
}: {
  dashboardId: string;
  pageId: string;
  onAdded: (item: DashboardItem) => void;
}) {
  const [value, setValue] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const thread = useRef<string>(`dash-${crypto.randomUUID()}`);

  async function run(question: string | null, clarification: string | null, original: string) {
    setPhase({ kind: "working", label: LABELS.thinking });
    try {
      for await (const ev of streamChat({
        question,
        thread_id: thread.current,
        clarification_answer: clarification,
        save: false,
      })) {
        if (ev.stage === "clarification") {
          setPhase({ kind: "clarify", question: ev.clarification_needed, candidates: ev.candidates, original });
          return;
        }
        if (ev.stage === "error") {
          setPhase({ kind: "error", message: ev.error });
          return;
        }
        if (ev.stage === "done") {
          if (!ev.sql || !ev.chart) {
            setPhase({ kind: "error", message: "That answer has nothing to chart." });
            return;
          }
          const item = await pinChart(dashboardId, {
            question: ev.question || original,
            sql: ev.sql,
            chart: ev.chart as ChartDecision,
            narration: ev.narration,
          }, pageId);
          onAdded(item);
          setValue("");
          setPhase({ kind: "idle" });
          thread.current = `dash-${crypto.randomUUID()}`;
          return;
        }
        if (LABELS[ev.stage]) setPhase({ kind: "working", label: LABELS[ev.stage] });
      }
    } catch (e) {
      setPhase({ kind: "error", message: e instanceof Error ? e.message : "Couldn't reach the agent." });
    }
  }

  function submit() {
    const q = value.trim();
    if (!q || phase.kind === "working") return;
    void run(q, null, q);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="panel flex items-center gap-3 rounded-2xl py-1.5 pr-1.5 pl-4 focus-within:shadow-[0_0_0_1px_var(--accent),0_0_28px_-8px_var(--glow)]">
        <Sparkles size={16} className="shrink-0 text-accent" />
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          disabled={phase.kind === "working"}
          placeholder="e.g. “weekly new customers this quarter”"
          aria-label="Ask a visual"
          className="min-w-0 flex-1 bg-transparent py-2 text-[14.5px] text-ink-primary outline-none placeholder:text-ink-muted disabled:opacity-60"
        />
        {phase.kind === "working" && <span className="hidden text-[12.5px] text-ink-muted sm:inline">{phase.label}</span>}
        <button
          onClick={submit}
          disabled={!value.trim() || phase.kind === "working"}
          aria-label="Add visual"
          className="beam-gradient flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-xl text-accent-ink transition-opacity disabled:cursor-not-allowed disabled:[background:var(--border-strong)] disabled:text-ink-muted"
        >
          {phase.kind === "working" ? (
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent-ink/30 border-t-accent-ink" />
          ) : (
            <ArrowUp size={16} strokeWidth={2.4} />
          )}
        </button>
      </div>
      {phase.kind === "clarify" && (
        <div className="panel animate-fade-up rounded-2xl p-5">
          <ClarificationChips
            question={phase.question}
            candidates={phase.candidates}
            onPick={(answer) => void run(null, answer, phase.original)}
          />
        </div>
      )}
      {phase.kind === "error" && <p className="px-1 text-[13px] text-status-critical">{phase.message}</p>}
    </div>
  );
}
