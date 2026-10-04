/**
 * Formatting commands for a contentEditable text box.
 *
 * Uses document.execCommand: formally deprecated, still implemented by
 * every browser, and the only built-in that applies formatting to an
 * arbitrary (possibly multi-element) selection correctly -- a hand-rolled
 * Range walker is a classic source of mangled markup. Whatever it produces
 * is re-sanitized server-side (api/richtext.py) before it's ever stored.
 *
 * execCommand only knows a few fixed values (font size 1-7, a color, a
 * font name), so exact values are applied with a SENTINEL: run the command
 * with a marker value, then rewrite every element carrying the marker to
 * the real CSS value. Same trick for "reset to theme color".
 */

let savedRange: Range | null = null;
let caretPoint: { x: number; y: number } | null = null;

/** Remember the selection inside `editor`. Anything in the toolbar that
 * takes focus (a <select>, the size input) would otherwise lose it. */
export function saveSelection(editor: HTMLElement | null) {
  const sel = window.getSelection();
  if (editor && sel && sel.rangeCount > 0 && editor.contains(sel.anchorNode)) {
    savedRange = sel.getRangeAt(0).cloneRange();
  }
}

export function restoreSelection(editor: HTMLElement) {
  editor.focus();
  if (!savedRange || !editor.contains(savedRange.startContainer)) return;
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(savedRange);
}

/** Is there a non-empty selection to format? Checks the LIVE selection,
 * and -- when focus has moved into the toolbar (size input, font menu) --
 * the one saved just before it did. Real bug: checking only the live
 * selection made a typed font size silently apply to the whole box. */
export function hasRangeSelection(editor: HTMLElement | null): boolean {
  if (!editor) return false;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && editor.contains(sel.anchorNode)) return true;
  return (
    document.activeElement !== editor &&
    !!savedRange &&
    !savedRange.collapsed &&
    editor.contains(savedRange.commonAncestorContainer)
  );
}

export function exec(editor: HTMLElement, command: string, value?: string) {
  restoreSelection(editor);
  document.execCommand("styleWithCSS", false, "true");
  document.execCommand(command, false, value);
  saveSelection(editor);
}

export function queryState(command: string): boolean {
  try {
    return document.queryCommandState(command);
  } catch {
    return false;
  }
}

function notify(editor: HTMLElement) {
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Font size in PAGE px on the selection (size-7 sentinel). */
export function setSelectionFontSize(editor: HTMLElement, px: number) {
  exec(editor, "fontSize", "7");
  editor.querySelectorAll<HTMLElement>('span[style*="xxx-large"], font[size="7"]').forEach((el) => {
    const target = el.tagName === "FONT" ? replaceWithSpan(el) : el;
    target.style.fontSize = `${px}px`;
  });
  saveSelection(editor);
  notify(editor);
}

const COLOR_SENTINEL = "#010203";
const COLOR_SENTINEL_RGB = "rgb(1, 2, 3)";

/** Color on the selection; `null` = back to the box's (theme) color,
 * WITHOUT touching bold/italic/underline -- the first version used
 * removeFormat for this and wiped every other mark too. */
export function setSelectionColor(editor: HTMLElement, color: string | null) {
  exec(editor, "foreColor", color ?? COLOR_SENTINEL);
  if (color === null) {
    editor.querySelectorAll<HTMLElement>("[style*='color'], font[color]").forEach((el) => {
      const isSentinel =
        el.style.color === COLOR_SENTINEL_RGB || el.getAttribute("color")?.toLowerCase() === COLOR_SENTINEL;
      if (!isSentinel) return;
      if (el.tagName === "FONT") replaceWithSpan(el);
      else el.style.removeProperty("color");
    });
    cleanEmptySpans(editor);
  }
  saveSelection(editor);
  notify(editor);
}

const FONT_SENTINEL = "askqlfontsentinel";

/** Font family on the selection. `css` is a CSS var reference such as
 * "var(--font-inter)" -- next/font's real family names are hashed. */
export function setSelectionFont(editor: HTMLElement, css: string) {
  exec(editor, "fontName", FONT_SENTINEL);
  editor
    .querySelectorAll<HTMLElement>(`[style*="${FONT_SENTINEL}"], font[face="${FONT_SENTINEL}"]`)
    .forEach((el) => {
      const target = el.tagName === "FONT" ? replaceWithSpan(el) : el;
      target.style.fontFamily = `${css}, sans-serif`;
    });
  saveSelection(editor);
  notify(editor);
}

function replaceWithSpan(el: HTMLElement): HTMLElement {
  const span = document.createElement("span");
  while (el.firstChild) span.appendChild(el.firstChild);
  el.replaceWith(span);
  return span;
}

function cleanEmptySpans(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>("span").forEach((s) => {
    if (!s.getAttribute("style")?.trim()) {
      s.removeAttribute("style");
      s.replaceWith(...Array.from(s.childNodes));
    }
  });
}

/** Removes one inline CSS property from every element under `root` -- so a
 * box-level change (whole-box size/color/font) actually applies to ALL of
 * the text instead of only the parts nobody had formatted individually. */
export function clearInlineStyle(root: HTMLElement, prop: "font-size" | "color" | "font-family") {
  root.querySelectorAll<HTMLElement>("[style]").forEach((el) => el.style.removeProperty(prop));
  root.querySelectorAll("font").forEach((f) => replaceWithSpan(f as HTMLElement));
  cleanEmptySpans(root);
}

/** clearInlineStyle for stored HTML (a box that isn't being edited). */
export function stripInlineStyleHtml(html: string, prop: "font-size" | "color" | "font-family"): string {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstElementChild as HTMLElement;
  clearInlineStyle(root, prop);
  return root.innerHTML;
}

/** Font size (page px) and family var at the caret, for the toolbar. */
export function styleAtCaret(editor: HTMLElement): { size: number | null; fontVar: string | null } {
  // the live caret if it's in the editor, else where it was before focus
  // moved into the toolbar or the format pane
  const live = window.getSelection()?.anchorNode;
  const node = live && editor.contains(live) ? live : savedRange?.startContainer;
  if (!node || !editor.contains(node)) return { size: null, fontVar: null };
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
  if (!el) return { size: null, fontVar: null };
  // Computed font-size ignores the zoom transform, so this IS page px.
  const size = parseFloat(getComputedStyle(el).fontSize) || null;
  const styled = el.closest<HTMLElement>("[style*='font-family']");
  const m = styled && editor.contains(styled) ? styled.style.fontFamily.match(/var\((--font-[a-z-]+)\)/) : null;
  return { size, fontVar: m ? `var(${m[1]})` : null };
}

/** Where to put the caret when editing starts -- the point the user
 * clicked, like any text editor, not always the end. */
export function setCaretPoint(x: number, y: number) {
  caretPoint = { x, y };
}

export function placeCaret(editor: HTMLElement) {
  const sel = window.getSelection();
  let range: Range | null = null;
  if (caretPoint && document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(caretPoint.x, caretPoint.y);
    if (r && editor.contains(r.startContainer)) range = r;
  }
  caretPoint = null;
  if (!range) {
    range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
  }
  sel?.removeAllRanges();
  sel?.addRange(range);
  saveSelection(editor);
}

/** Legacy (pre-rich-text) text tiles stored plain text / a markdown subset.
 * Opening one in the rich editor starts from its text with line breaks. */
export function plainToHtml(text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc
    .split(/\n/)
    .map((l) => `<div>${l.replace(/^#+\s+/, "") || "<br>"}</div>`)
    .join("");
}
