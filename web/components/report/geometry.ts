/**
 * Canvas geometry for the report editor -- pure functions, page pixels in,
 * page pixels out. Two kinds of snapping, in priority order:
 *
 *  1. Smart guides: an edge or center of the moving box within a few screen
 *     pixels of another visual's edge/center (or the page's) locks onto it,
 *     and a guide line is drawn -- the Power BI / Figma alignment feel.
 *  2. Otherwise the 8px grid.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Guide {
  axis: "x" | "y"; // "x": a vertical line at x = pos
  pos: number;
  from: number;
  to: number;
}

export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const GRID = 8;
export const MIN_W = 48;
export const MIN_H = 32;
const SNAP_SCREEN_PX = 6;

const snapGrid = (v: number) => Math.round(v / GRID) * GRID;

interface Bounds {
  w: number;
  h: number;
}

/** Candidate lines (x or y) from the page and every other visual. */
function targets(axis: "x" | "y", others: Rect[], page: Bounds) {
  const out: { pos: number; span: [number, number] }[] = [];
  const pageLen = axis === "x" ? page.w : page.h;
  const pageSpan: [number, number] = [0, axis === "x" ? page.h : page.w];
  for (const pos of [0, pageLen / 2, pageLen]) out.push({ pos, span: pageSpan });
  for (const o of others) {
    const start = axis === "x" ? o.x : o.y;
    const len = axis === "x" ? o.w : o.h;
    const span: [number, number] = axis === "x" ? [o.y, o.y + o.h] : [o.x, o.x + o.w];
    for (const pos of [start, start + len / 2, start + len]) out.push({ pos, span });
  }
  return out;
}

/** Best alignment for a set of anchor offsets along one axis. */
function bestSnap(
  anchors: number[],
  axis: "x" | "y",
  others: Rect[],
  page: Bounds,
  threshold: number
): { delta: number; pos: number; span: [number, number] } | null {
  let best: { delta: number; pos: number; span: [number, number] } | null = null;
  for (const t of targets(axis, others, page)) {
    for (const a of anchors) {
      const d = t.pos - a;
      if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.delta))) {
        best = { delta: d, pos: t.pos, span: t.span };
      }
    }
  }
  return best;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

export function snapMove(raw: Rect, others: Rect[], page: Bounds, scale: number): { rect: Rect; guides: Guide[] } {
  const threshold = SNAP_SCREEN_PX / scale;
  const guides: Guide[] = [];
  let { x, y } = raw;
  const { w, h } = raw;

  const sx = bestSnap([x, x + w / 2, x + w], "x", others, page, threshold);
  if (sx) {
    x += sx.delta;
    guides.push({ axis: "x", pos: sx.pos, from: Math.min(sx.span[0], y), to: Math.max(sx.span[1], y + h) });
  } else x = snapGrid(x);

  const sy = bestSnap([y, y + h / 2, y + h], "y", others, page, threshold);
  if (sy) {
    y += sy.delta;
    guides.push({ axis: "y", pos: sy.pos, from: Math.min(sy.span[0], x), to: Math.max(sy.span[1], x + w) });
  } else y = snapGrid(y);

  return {
    rect: { x: clamp(x, 0, Math.max(0, page.w - w)), y: clamp(y, 0, Math.max(0, page.h - h)), w, h },
    guides,
  };
}

/** Resize from `handle` by (dx, dy) page px, snapping only the edges that
 * are actually moving. */
export function snapResize(
  start: Rect,
  handle: Handle,
  dx: number,
  dy: number,
  others: Rect[],
  page: Bounds,
  scale: number
): { rect: Rect; guides: Guide[] } {
  const threshold = SNAP_SCREEN_PX / scale;
  const guides: Guide[] = [];
  let left = start.x;
  let right = start.x + start.w;
  let top = start.y;
  let bottom = start.y + start.h;

  const snapEdge = (v: number, axis: "x" | "y") => {
    const s = bestSnap([v], axis, others, page, threshold);
    if (s) {
      guides.push(
        axis === "x"
          ? { axis, pos: s.pos, from: Math.min(s.span[0], top), to: Math.max(s.span[1], bottom) }
          : { axis, pos: s.pos, from: Math.min(s.span[0], left), to: Math.max(s.span[1], right) }
      );
      return v + s.delta;
    }
    return snapGrid(v);
  };

  if (handle.includes("w")) left = clamp(snapEdge(start.x + dx, "x"), 0, right - MIN_W);
  if (handle.includes("e")) right = clamp(snapEdge(start.x + start.w + dx, "x"), left + MIN_W, page.w);
  if (handle.includes("n")) top = clamp(snapEdge(start.y + dy, "y"), 0, bottom - MIN_H);
  if (handle.includes("s")) bottom = clamp(snapEdge(start.y + start.h + dy, "y"), top + MIN_H, page.h);

  return { rect: { x: left, y: top, w: right - left, h: bottom - top }, guides };
}
