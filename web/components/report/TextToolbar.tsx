"use client";

import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  Italic,
  List,
  ListOrdered,
  Minus,
  Plus,
  RemoveFormatting,
  Strikethrough,
  Underline,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { DashboardItem, FontFamily, TileConfig } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  exec,
  hasRangeSelection,
  queryState,
  saveSelection,
  setSelectionColor,
  setSelectionFont,
  setSelectionFontSize,
  styleAtCaret,
} from "./richtext";
import { FONT_OPTIONS, PALETTE_SWATCHES } from "./visualStyle";

function Btn({
  label,
  active,
  onRun,
  children,
}: {
  label: string;
  active?: boolean;
  onRun: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      // mousedown, not click, with preventDefault: the editor must keep
      // focus and its selection, or the command has nothing to act on.
      onMouseDown={(e) => {
        e.preventDefault();
        onRun();
      }}
      className={cn(
        "flex h-7 w-7 cursor-pointer items-center justify-center rounded-md transition-colors",
        active ? "bg-accent-wash text-accent" : "text-ink-secondary hover:bg-surface-raised hover:text-ink-primary"
      )}
    >
      {children}
    </button>
  );
}

const Sep = () => <span className="mx-0.5 h-5 w-px bg-border-strong" />;

/**
 * Floating formatting bar for the text box being edited -- Power BI's text
 * box toolbar. Every control works the same way: with words SELECTED it
 * formats just those words; with nothing selected it sets the whole box
 * (and the page clears any per-word override of that property, so the
 * whole box really does change -- see onConfig in the report page).
 */
export function TextToolbar({
  item,
  editor,
  onConfig,
}: {
  item: DashboardItem;
  editor: HTMLDivElement | null;
  onConfig: (config: TileConfig) => void;
}) {
  const cfg = item.config;
  const [, rerender] = useState(0);
  const [sizeDraft, setSizeDraft] = useState<string | null>(null);
  const [caret, setCaret] = useState<{ size: number | null; fontVar: string | null }>({ size: null, fontVar: null });
  const [colorOpen, setColorOpen] = useState(false);

  // Reflect the caret's real formatting: B/I/U state, and its actual font
  // size and family -- not just the box default.
  useEffect(() => {
    const onSel = () => {
      rerender((n) => n + 1);
      if (editor && document.activeElement === editor) setCaret(styleAtCaret(editor));
    };
    onSel();
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, [editor]);

  // A box-level change from the format pane (size/font) restyles the text
  // without moving the caret -- re-read what the caret is actually in.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing from the DOM, an external system
    if (editor) setCaret(styleAtCaret(editor));
  }, [editor, cfg.font_size, cfg.font_family, item.text]);

  if (!editor) return null;

  const set = (patch: Partial<TileConfig>) => onConfig({ ...cfg, ...patch });
  const run = (cmd: string, value?: string) => {
    exec(editor, cmd, value);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    rerender((n) => n + 1);
  };

  const shownSize = Math.round(caret.size ?? cfg.font_size);
  const shownFont = FONT_OPTIONS.find((f) => f.css === caret.fontVar)?.value ?? cfg.font_family;

  function applySize(px: number) {
    const v = Math.max(8, Math.min(120, Math.round(px)));
    setSizeDraft(null);
    if (hasRangeSelection(editor)) setSelectionFontSize(editor!, v);
    else set({ font_size: v });
    setCaret((c) => ({ ...c, size: v }));
  }

  function applyFont(value: FontFamily) {
    const opt = FONT_OPTIONS.find((f) => f.value === value)!;
    if (hasRangeSelection(editor)) setSelectionFont(editor!, opt.css);
    else set({ font_family: value });
    setCaret((c) => ({ ...c, fontVar: opt.css }));
  }

  function applyColor(hex: string | null) {
    setColorOpen(false);
    if (hasRangeSelection(editor)) setSelectionColor(editor!, hex);
    else set({ text_color: hex });
  }

  return (
    <div
      className="no-drag panel flex items-center gap-0.5 rounded-xl px-1.5 py-1"
      role="toolbar"
      aria-label="Text formatting"
      onMouseDown={(e) => {
        // keep editor focus for clicks on the bar's own background
        const tag = (e.target as HTMLElement).tagName;
        if (tag !== "SELECT" && tag !== "INPUT" && tag !== "OPTION") e.preventDefault();
      }}
    >
      <select
        aria-label="Font"
        value={shownFont}
        onMouseDown={() => saveSelection(editor)}
        onChange={(e) => applyFont(e.target.value as FontFamily)}
        className="h-7 cursor-pointer rounded-md border border-border bg-surface px-1.5 text-[12.5px] text-ink-primary outline-none"
      >
        {FONT_OPTIONS.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>

      <select
        aria-label="Paragraph style"
        value=""
        onMouseDown={() => saveSelection(editor)}
        onChange={(e) => run("formatBlock", e.target.value)}
        className="h-7 cursor-pointer rounded-md border border-border bg-surface px-1.5 text-[12.5px] text-ink-primary outline-none"
      >
        <option value="" disabled>
          Style
        </option>
        <option value="h1">Title</option>
        <option value="h2">Heading</option>
        <option value="h3">Subheading</option>
        <option value="div">Body</option>
      </select>

      <div className="ml-0.5 flex items-center rounded-md border border-border">
        <Btn label="Smaller" onRun={() => applySize(shownSize - 2)}>
          <Minus size={12} />
        </Btn>
        <input
          aria-label="Font size"
          inputMode="numeric"
          value={sizeDraft ?? String(shownSize)}
          onMouseDown={() => saveSelection(editor)}
          onFocus={(e) => e.target.select()}
          onChange={(e) => setSizeDraft(e.target.value.replace(/\D/g, "").slice(0, 3))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (sizeDraft) applySize(Number(sizeDraft));
              editor.focus();
            } else if (e.key === "Escape") {
              setSizeDraft(null);
              editor.focus();
            }
          }}
          onBlur={() => {
            if (sizeDraft && Number(sizeDraft) !== shownSize) applySize(Number(sizeDraft));
            else setSizeDraft(null);
          }}
          className="w-8 bg-transparent text-center text-[12.5px] tabular-nums text-ink-primary outline-none"
        />
        <Btn label="Larger" onRun={() => applySize(shownSize + 2)}>
          <Plus size={12} />
        </Btn>
      </div>

      <Sep />
      <Btn label="Bold" active={queryState("bold")} onRun={() => run("bold")}>
        <Bold size={14} />
      </Btn>
      <Btn label="Italic" active={queryState("italic")} onRun={() => run("italic")}>
        <Italic size={14} />
      </Btn>
      <Btn label="Underline" active={queryState("underline")} onRun={() => run("underline")}>
        <Underline size={14} />
      </Btn>
      <Btn label="Strikethrough" active={queryState("strikeThrough")} onRun={() => run("strikeThrough")}>
        <Strikethrough size={14} />
      </Btn>

      <div className="relative">
        <Btn label="Text color" onRun={() => setColorOpen((v) => !v)}>
          <span className="flex flex-col items-center">
            <span className="text-[13px] leading-none font-semibold">A</span>
            <span className="beam-gradient mt-0.5 h-[3px] w-3.5 rounded-full" />
          </span>
        </Btn>
        {colorOpen && (
          <div className="animate-fade-up absolute top-full left-0 z-10 mt-1.5 grid w-[188px] grid-cols-7 gap-1.5 rounded-xl border border-border-strong bg-surface-raised p-2 shadow-[var(--shadow-float)]">
            <button
              type="button"
              aria-label="Theme text color"
              title="Theme default"
              onMouseDown={(e) => {
                e.preventDefault();
                applyColor(null);
              }}
              className="h-5 w-5 cursor-pointer rounded-full border border-border-strong bg-[conic-gradient(var(--ink-primary)_0_50%,var(--plane)_0)]"
            />
            {PALETTE_SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Color ${c}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  applyColor(c);
                }}
                className="h-5 w-5 cursor-pointer rounded-full border border-border transition-transform hover:scale-110"
                style={{ background: c }}
              />
            ))}
          </div>
        )}
      </div>

      <Sep />
      {(
        [
          ["left", AlignLeft],
          ["center", AlignCenter],
          ["right", AlignRight],
          ["justify", AlignJustify],
        ] as const
      ).map(([a, Icon]) => (
        <Btn key={a} label={`Align ${a}`} active={cfg.align === a} onRun={() => set({ align: a })}>
          <Icon size={14} />
        </Btn>
      ))}
      <Sep />
      <Btn label="Bulleted list" active={queryState("insertUnorderedList")} onRun={() => run("insertUnorderedList")}>
        <List size={14} />
      </Btn>
      <Btn label="Numbered list" active={queryState("insertOrderedList")} onRun={() => run("insertOrderedList")}>
        <ListOrdered size={14} />
      </Btn>
      <Btn label="Clear formatting" onRun={() => run("removeFormat")}>
        <RemoveFormatting size={14} />
      </Btn>
    </div>
  );
}
