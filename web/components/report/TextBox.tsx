"use client";

import { useEffect, useRef } from "react";
import { Markdown } from "@/components/dashboards/Markdown";
import type { DashboardItem } from "@/lib/types";
import { placeCaret, plainToHtml, saveSelection } from "./richtext";
import { frame } from "./visualStyle";

/**
 * A text box on the report page. Its content is laid out at PAGE size and
 * scaled with a transform, so every inline size -- including per-selection
 * pixel font sizes -- zooms with the page exactly like the rest of it.
 *
 * Read mode renders the stored HTML, which the API only ever stores after
 * its allowlist sanitizer (api/richtext.py). Edit mode is an uncontrolled
 * contentEditable: React never re-renders its children while editing, so
 * the caret and the browser's undo stack stay intact.
 */
export function TextBox({
  item,
  scale,
  editing,
  onEditorMount,
  onInput,
  onGrow,
}: {
  item: DashboardItem;
  scale: number;
  editing: boolean;
  onEditorMount?: (el: HTMLDivElement | null) => void;
  onInput?: (html: string) => void;
  /** Content outgrew the box: the page-px height the box needs. */
  onGrow?: (height: number) => void;
}) {
  const cfg = item.config;
  const pad = frame(item).padding;
  const innerW = item.layout.w - pad * 2;
  const innerH = item.layout.h - pad * 2;
  const editorRef = useRef<HTMLDivElement>(null);

  const markEmpty = (el: HTMLElement) =>
    el.setAttribute("data-empty", String(!el.textContent?.trim() && !el.querySelector("li")));

  /** Real bug: the box never grew, so a second line or a heading pushed the
   * first line out of view behind an inner scrollbar -- formatting looked
   * broken when it had actually applied. Grow the box to fit instead. */
  const fit = (el: HTMLElement) => {
    if (el.scrollHeight > el.clientHeight + 1) onGrow?.(Math.ceil(el.scrollHeight + pad * 2 + 4));
  };

  useEffect(() => {
    const el = editorRef.current;
    if (!editing || !el) return;
    el.innerHTML = cfg.text_format === "html" ? item.text ?? "" : plainToHtml(item.text ?? "");
    markEmpty(el);
    el.focus();
    placeCaret(el);
    onEditorMount?.(el);
    return () => onEditorMount?.(null);
    // Seed ONCE per edit session -- re-seeding on every prop change would
    // clobber what's being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // Formatting from the toolbar/pane (bigger font, heading style) can also
  // overflow the box -- re-check whenever the box-level text style changes.
  useEffect(() => {
    if (editing && editorRef.current) fit(editorRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, cfg.font_size, cfg.line_height, cfg.font_family, item.layout.w]);

  const textStyle = {
    fontSize: cfg.font_size,
    color: cfg.text_color ?? "var(--ink-primary)",
    textAlign: cfg.align,
    lineHeight: cfg.line_height,
  } as const;

  return (
    <div
      style={{
        width: innerW,
        height: innerH,
        transform: `scale(${scale})`,
        transformOrigin: "0 0",
        display: "flex",
        flexDirection: "column",
        justifyContent: cfg.valign === "middle" ? "center" : cfg.valign === "bottom" ? "flex-end" : "flex-start",
      }}
    >
      {editing ? (
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label="Text box content"
          data-placeholder="Type something…"
          onInput={(e) => {
            const el = e.currentTarget;
            markEmpty(el);
            fit(el);
            onInput?.(el.innerHTML);
          }}
          // Paste as plain text: rich paste from a web page drags in its
          // own fonts, colors, images and links.
          onPaste={(e) => {
            e.preventDefault();
            document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
          }}
          onKeyUp={() => saveSelection(editorRef.current)}
          onMouseUp={() => saveSelection(editorRef.current)}
          className={`richtext no-drag tb-font-${cfg.font_family} max-h-full min-h-[1.4em] cursor-text overflow-auto outline-none`}
          style={textStyle}
        />
      ) : cfg.text_format === "html" ? (
        item.text && item.text.replace(/<[^>]*>/g, "").trim() ? (
          <div
            className={`richtext tb-font-${cfg.font_family} max-h-full overflow-hidden`}
            style={textStyle}
            // Sanitized server-side on every write -- see the docstring above.
            dangerouslySetInnerHTML={{ __html: item.text }}
          />
        ) : (
          <p className={`tb-font-${cfg.font_family}`} style={{ ...textStyle, color: "var(--ink-muted)" }}>
            Double-click to write
          </p>
        )
      ) : (
        <div className={`tb-font-${cfg.font_family}`} style={textStyle}>
          <Markdown source={item.text ?? ""} />
        </div>
      )}
    </div>
  );
}
