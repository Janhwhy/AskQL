"use client";

import { useState, type KeyboardEvent } from "react";
import { ArrowUp } from "lucide-react";

export function ChatInput({
  onSend,
  disabled,
}: {
  onSend: (question: string) => void;
  disabled?: boolean;
}) {
  const [value, setValue] = useState("");

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
    <div className="flex items-end gap-2 rounded-2xl border border-border-strong bg-surface p-2 shadow-[0_2px_12px_rgba(0,0,0,0.04)] transition-colors focus-within:border-accent">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        rows={1}
        placeholder="Ask about revenue, customers, support tickets…"
        className="max-h-32 flex-1 resize-none bg-transparent px-2 py-2 text-[15px] text-ink-primary placeholder:text-ink-muted focus:outline-none disabled:opacity-50"
      />
      <button
        onClick={submit}
        disabled={disabled || !value.trim()}
        aria-label="Send"
        className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-xl bg-accent text-accent-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
      >
        <ArrowUp size={18} />
      </button>
    </div>
  );
}
