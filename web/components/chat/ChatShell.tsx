"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { streamChat } from "@/lib/api";
import { getChat } from "@/lib/chatApi";
import type { ChatEvent, SavedTurn, Turn } from "@/lib/types";
import { useChats } from "@/components/shell/ChatsProvider";
import { ChatInput } from "./ChatInput";
import { EmptyState } from "./EmptyState";
import { MessageTurn } from "./MessageTurn";

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
    stage: "thinking",
    fresh: true,
  };
}

function fromSaved(t: SavedTurn): Turn {
  return { ...t, retried: false, stage: null };
}

/**
 * One conversation. `chatId === null` is a new, unsaved chat: the first
 * message mints an id (which the backend uses as the agent's thread_id AND
 * the saved chat's id), then swaps the URL to /c/{id} with replaceState --
 * Next's router syncs usePathname to it without a navigation, so this
 * component (and the answer streaming into it) is never remounted.
 *
 * Turns are persisted server-side by /chat itself (api/main.py), never from
 * here -- this component only renders and, for a saved chat, hydrates.
 */
export function ChatShell({ chatId }: { chatId: string | null }) {
  const { refresh, setBusy: setGlobalBusy } = useChats();
  const pathname = usePathname();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(chatId !== null);
  const [missing, setMissing] = useState(false);
  const threadId = useRef<string | null>(chatId);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!chatId) return;
    let cancelled = false;
    getChat(chatId)
      .then((chat) => !cancelled && setTurns(chat.turns.map(fromSaved)))
      .catch(() => !cancelled && setMissing(true))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [chatId]);

  // "New question" while already on a fresh chat that has since been given
  // an id via replaceState: the router sees /c/{id} -> / as a same-page
  // navigation and keeps this component mounted, so reset it explicitly.
  useEffect(() => {
    if (chatId === null && pathname === "/" && threadId.current !== null) {
      threadId.current = null;
      setTurns([]);
    }
  }, [pathname, chatId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && turns.length > 0) el.scrollTo({ top: el.scrollHeight, behavior: loading ? "auto" : "smooth" });
  }, [turns, loading]);

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
          updateLastTurn((t) => ({ ...t, stage: "thinking" }));
          break;
        case "sql":
          updateLastTurn((t) => ({ ...t, sql: event.sql, stage: "sql" }));
          break;
        case "retrying":
          updateLastTurn((t) => ({ ...t, retried: true, stage: "retrying" }));
          break;
        case "result":
          updateLastTurn((t) => ({ ...t, columns: event.columns, rows: event.rows, stage: "result" }));
          break;
        case "chart":
          updateLastTurn((t) => ({ ...t, chart: event.chart, stage: "chart" }));
          break;
        case "narration":
          updateLastTurn((t) => ({ ...t, narration: event.narration, stage: "narration" }));
          break;
        case "clarification":
          updateLastTurn((t) => ({
            ...t,
            status: "clarification",
            clarification: { question: event.clarification_needed, candidates: event.candidates },
            stage: null,
          }));
          break;
        case "error":
          updateLastTurn((t) => ({ ...t, status: "error", error: event.error, sql: event.sql ?? t.sql, stage: null }));
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
            stage: null,
          }));
          break;
      }
    },
    [updateLastTurn]
  );

  const runTurn = useCallback(
    async (question: string | null, clarificationAnswer: string | null) => {
      let isNewChat = false;
      if (threadId.current === null) {
        threadId.current = crypto.randomUUID();
        isNewChat = true;
        window.history.replaceState(null, "", `/c/${threadId.current}`);
      }
      setBusy(true);
      setGlobalBusy(true);
      let first = true;
      try {
        for await (const event of streamChat({
          question,
          thread_id: threadId.current,
          clarification_answer: clarificationAnswer,
        })) {
          applyEvent(event);
          // The backend creates the chat row before streaming starts, so
          // the sidebar can show a brand-new chat right away.
          if (first && isNewChat) void refresh();
          first = false;
        }
      } catch (e) {
        updateLastTurn((t) => ({
          ...t,
          status: "error",
          error: e instanceof Error ? `Couldn't reach the agent: ${e.message}` : "Something went wrong talking to the agent.",
          stage: null,
        }));
      } finally {
        setBusy(false);
        setGlobalBusy(false);
        void refresh();
      }
    },
    [applyEvent, updateLastTurn, refresh, setGlobalBusy]
  );

  function handleSend(question: string) {
    setTurns((prev) => [...prev, newTurn(question)]);
    void runTurn(question, null);
  }

  function handleClarify(answer: string) {
    updateLastTurn((t) => ({ ...t, status: "streaming", clarification: null, stage: "thinking" }));
    void runTurn(null, answer);
  }

  const empty = !loading && turns.length === 0;

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[880px] flex-col px-5 pt-10 pb-10 sm:px-10">
          {missing ? (
            <div className="animate-rise py-24 text-center">
              <p className="font-display text-4xl text-ink-primary">This chat isn&apos;t here.</p>
              <p className="mt-2 text-sm text-ink-muted">It may have been deleted. Start a new question from the sidebar.</p>
            </div>
          ) : loading ? (
            <div className="flex flex-col gap-4 py-10" aria-label="Loading chat">
              {[0, 1].map((i) => (
                <div key={i} className="h-32 animate-pulse rounded-3xl bg-surface/70" />
              ))}
            </div>
          ) : empty ? (
            <EmptyState onPick={handleSend} />
          ) : (
            <div className="flex flex-col gap-14">
              {turns.map((turn, i) => (
                <MessageTurn
                  key={turn.id}
                  index={i + 1}
                  turn={turn}
                  onClarify={handleClarify}
                  disabled={busy}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="relative shrink-0 px-5 pb-5 sm:px-10">
        <div className="pointer-events-none absolute inset-x-0 -top-10 h-10 bg-gradient-to-t from-plane to-transparent" />
        <div className="mx-auto max-w-[880px]">
          <ChatInput
            onSend={handleSend}
            disabled={busy || missing}
            hasHistory={turns.some((t) => t.status === "done")}
          />
        </div>
      </div>
    </div>
  );
}
