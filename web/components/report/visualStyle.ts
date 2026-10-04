import type { CSSProperties } from "react";
import type { DashboardItem } from "@/lib/types";

/** Container defaults per kind -- a chart reads as a card, a text box as
 * text sitting directly on the page, until the format pane says otherwise. */
const DEFAULTS = {
  chart: { background: "var(--surface-raised)", border: true, shadow: true, radius: 14, padding: 16 },
  text: { background: "transparent", border: false, shadow: false, radius: 8, padding: 12 },
} as const;

export function frame(item: DashboardItem) {
  const d = DEFAULTS[item.kind];
  const c = item.config;
  return {
    background: c.background ?? d.background,
    border: c.border ?? d.border,
    shadow: c.shadow ?? d.shadow,
    radius: c.radius ?? d.radius,
    padding: c.padding ?? d.padding,
  };
}

/** Screen-space container style for a visual at the given zoom. */
export function frameStyle(item: DashboardItem, scale: number): CSSProperties {
  const f = frame(item);
  return {
    background: f.background,
    border: f.border ? "1px solid var(--border-strong)" : "1px solid transparent",
    boxShadow: f.shadow ? "var(--shadow-float)" : undefined,
    borderRadius: f.radius * scale,
    padding: f.padding * scale,
  };
}

export const PALETTE_SWATCHES = [
  "#ffffff",
  "#d4d4d4",
  "#737373",
  "#262626",
  "#0a0a0a",
  "#2a78d6",
  "#eb6834",
  "#1baf7a",
  "#eda100",
  "#e87ba4",
  "#008300",
  "#4a3aa7",
  "#e34948",
  "#ff6b2c",
];

/** `css` = the next/font variable, used for PER-SELECTION fonts (inline
 * style); `value` = the box-level TileConfig.font_family key. */
export const FONT_OPTIONS = [
  { value: "geist", label: "Geist", css: "var(--font-geist-sans)" },
  { value: "inter", label: "Inter", css: "var(--font-inter)" },
  { value: "dm_sans", label: "DM Sans", css: "var(--font-dm-sans)" },
  { value: "manrope", label: "Manrope", css: "var(--font-manrope)" },
  { value: "space_grotesk", label: "Space Grotesk", css: "var(--font-space-grotesk)" },
  { value: "plex_sans", label: "IBM Plex Sans", css: "var(--font-plex-sans)" },
  { value: "work_sans", label: "Work Sans", css: "var(--font-work-sans)" },
] as const;
