"use client";

import { ArrowUp, CornerDownLeft } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

export function ChatInput({
  onSend,
  disabled,
  hasHistory,
}: {
  onSend: (question: string) => void;
  disabled?: boolean;
  /** A prior answer exists on this chat, so follow-ups have context. */
  hasHistory?: boolean;
}) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  // grow with content up to max-h, then scroll
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  function submit() {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="group panel relative flex items-end gap-2 rounded-[20px] p-2 pl-4 transition-shadow focus-within:shadow-[0_0_0_1px_var(--accent),0_0_32px_-6px_var(--glow),var(--shadow-float)]">
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          rows={1}
          placeholder={
            hasHistory
              ? "Ask about revenue, customers, support tickets… or refine the last answer"
              : "Ask about revenue, customers, support tickets…"
          }
          className="max-h-40 min-h-[40px] flex-1 resize-none bg-transparent py-2.5 text-[15.5px] text-ink-primary placeholder:text-ink-muted focus:outline-none disabled:opacity-50"
        />
        <button
          onClick={submit}
          disabled={disabled || !value.trim()}
          aria-label="Send"
          className="beam-gradient flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-[14px] text-accent-ink shadow-[0_6px_20px_-6px_var(--glow)] transition-all hover:scale-[1.04] disabled:cursor-not-allowed disabled:[background:var(--border-strong)] disabled:text-ink-muted disabled:shadow-none disabled:hover:scale-100"
        >
          <ArrowUp size={18} strokeWidth={2.4} />
        </button>
      </div>
      <p className="flex items-center justify-between gap-4 px-2 text-[11.5px] text-ink-muted">
        <span>
          {hasHistory
            ? "Follow-ups build on the last answer — try “now by region” or “as a table”."
            : "Answers come only from governed metrics. If it can't be answered, it'll say so."}
        </span>
        <span className="hidden items-center gap-1 font-mono sm:flex">
          <CornerDownLeft size={11} /> ask · shift+↵ newline
        </span>
      </p>
    </div>
  );
}
