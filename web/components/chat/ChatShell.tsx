"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { streamChat } from "@/lib/api";
import type { ChatEvent, Turn } from "@/lib/types";
import { ChatInput } from "./ChatInput";
import { EmptyState } from "./EmptyState";
import { MessageTurn } from "./MessageTurn";

const STAGE_LABELS: Record<string, string> = {
  thinking: "Thinking…",
  sql: "Finding the right metric…",
  retrying: "Hit an error, retrying once…",
  result: "Running the query…",
  chart: "Building the chart…",
  narration: "Writing the insight…",
};

function newTurn(question: string): Turn {
  return {
    id: crypto.randomUUID(),
    question,
    status: "streaming",
    sql: null,
    columns: null,
    rows: [],
    chart: null,
    narration: null,
    clarification: null,
    error: null,
    retried: false,
    stageLabel: STAGE_LABELS.thinking,
  };
}

export function ChatShell() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const threadId = useRef<string>(crypto.randomUUID());
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  const updateLastTurn = useCallback((updater: (t: Turn) => Turn) => {
    setTurns((prev) => {
      if (prev.length === 0) return prev;
      const next = [...prev];
      next[next.length - 1] = updater(next[next.length - 1]);
      return next;
    });
  }, []);

  const applyEvent = useCallback(
    (event: ChatEvent) => {
      switch (event.stage) {
        case "thinking":
          updateLastTurn((t) => ({ ...t, stageLabel: STAGE_LABELS.thinking }));
          break;
        case "sql":
          updateLastTurn((t) => ({ ...t, sql: event.sql, stageLabel: STAGE_LABELS.sql }));
          break;
        case "retrying":
          updateLastTurn((t) => ({ ...t, retried: true, stageLabel: STAGE_LABELS.retrying }));
          break;
        case "result":
          updateLastTurn((t) => ({
            ...t,
            columns: event.columns,
            rows: event.rows,
            stageLabel: STAGE_LABELS.result,
          }));
          break;
        case "chart":
          updateLastTurn((t) => ({ ...t, chart: event.chart, stageLabel: STAGE_LABELS.chart }));
          break;
        case "narration":
          updateLastTurn((t) => ({
            ...t,
            narration: event.narration,
            stageLabel: STAGE_LABELS.narration,
          }));
          break;
        case "clarification":
          updateLastTurn((t) => ({
            ...t,
            status: "clarification",
            clarification: {
              question: event.clarification_needed,
              candidates: event.candidates,
            },
            stageLabel: null,
          }));
          break;
        case "error":
          updateLastTurn((t) => ({
            ...t,
            status: "error",
            error: event.error,
            sql: event.sql ?? t.sql,
            stageLabel: null,
          }));
          break;
        case "done":
          updateLastTurn((t) => ({
            ...t,
            status: "done",
            sql: event.sql ?? t.sql,
            columns: event.columns ?? t.columns,
            rows: event.rows,
            chart: event.chart,
            narration: event.narration,
            stageLabel: null,
          }));
          break;
      }
    },
    [updateLastTurn]
  );

  const runTurn = useCallback(
    async (question: string | null, clarificationAnswer: string | null) => {
      setBusy(true);
      try {
        for await (const event of streamChat({
          question,
          thread_id: threadId.current,
          clarification_answer: clarificationAnswer,
        })) {
          applyEvent(event);
        }
      } catch (e) {
        updateLastTurn((t) => ({
          ...t,
          status: "error",
          error:
            e instanceof Error
              ? `Couldn't reach the agent: ${e.message}`
              : "Something went wrong talking to the agent.",
          stageLabel: null,
        }));
      } finally {
        setBusy(false);
      }
    },
    [applyEvent, updateLastTurn]
  );

  function handleSend(question: string) {
    setTurns((prev) => [...prev, newTurn(question)]);
    void runTurn(question, null);
  }

  function handleClarify(answer: string) {
    updateLastTurn((t) => ({
      ...t,
      status: "streaming",
      clarification: null,
      stageLabel: STAGE_LABELS.thinking,
    }));
    void runTurn(null, answer);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-8">
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          {turns.length === 0 ? (
            <EmptyState onPick={handleSend} />
          ) : (
            turns.map((turn) => (
              <MessageTurn key={turn.id} turn={turn} onClarify={handleClarify} />
            ))
          )}
          <div ref={bottomRef} />
        </div>
      </div>
      <div className="border-t border-border px-4 py-4 sm:px-8">
        <div className="mx-auto max-w-3xl">
          <ChatInput onSend={handleSend} disabled={busy} />
        </div>
      </div>
    </div>
  );
}
