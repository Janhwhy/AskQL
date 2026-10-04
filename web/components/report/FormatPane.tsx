"use client";

import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  AlignJustify,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  AreaChart,
  BarChart3,
  BarChartHorizontal,
  CircleDot,
  Hash,
  LineChart,
  PieChart,
  Table2,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { compatibleDisplayTypes } from "@/components/chat/ChartRenderer";
import { SqlButton } from "@/components/chat/SqlButton";
import type { DashboardItem, DisplayType, FontFamily, ReportPage, TileConfig } from "@/lib/types";
import { cn } from "@/lib/utils";
import { DISPLAY_LABELS } from "./ChartVisual";
import { FONT_OPTIONS, frame, PALETTE_SWATCHES } from "./visualStyle";

const ICONS: Record<DisplayType, typeof Hash> = {
  kpi: Hash,
  line: LineChart,
  area: AreaChart,
  bar: BarChart3,
  hbar: BarChartHorizontal,
  pie: PieChart,
  donut: CircleDot,
  table: Table2,
};

const PAGE_SIZES = [
  { label: "16:9", w: 1280, h: 720 },
  { label: "4:3", w: 960, h: 720 },
  { label: "Letter", w: 816, h: 1056 },
  { label: "Long", w: 1280, h: 1440 },
];

/* ---- small building blocks ------------------------------------------- */

function Section({ title, children, defaultOpen = true }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-border">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center justify-between px-4 py-3 text-left"
      >
        <span className="text-[12.5px] font-semibold text-ink-primary">{title}</span>
        <span className={cn("text-ink-muted transition-transform", open ? "rotate-90" : "")}>›</span>
      </button>
      {open && <div className="flex flex-col gap-3.5 px-4 pb-4">{children}</div>}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11.5px] text-ink-muted">{label}</span>
      {children}
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[13px] text-ink-secondary">
      <span>{label}</span>
      <button
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative h-[20px] w-[34px] cursor-pointer rounded-full border transition-colors",
          checked ? "beam-gradient border-transparent" : "border-border-strong bg-sunken"
        )}
      >
        <span
          className={cn(
            "absolute top-[2px] h-3.5 w-3.5 rounded-full bg-surface-raised shadow transition-all",
            checked ? "left-[16px]" : "left-[2px]"
          )}
        />
      </button>
    </div>
  );
}

function NumberInput({ value, onChange, min, max, step = 1, suffix, label }: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  label: string;
}) {
  // Real bug: clamping on EVERY keystroke made typing impossible -- to
  // enter 24, the "2" was clamped to the minimum 8, then "4" appended: 84.
  // Keep a free-form draft while typing; apply live only when the draft is
  // already a valid in-range number; clamp on commit (Enter / blur).
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const v = Number(draft);
    if (draft.trim() !== "" && !Number.isNaN(v)) onChange(Math.max(min, Math.min(max, v)));
    setDraft(null);
  };
  return (
    <label className="flex items-center gap-2 rounded-lg border border-border bg-sunken px-2.5 py-1.5 focus-within:border-accent">
      <input
        type="number"
        aria-label={label}
        value={draft ?? String(value)}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          setDraft(e.target.value);
          const v = Number(e.target.value);
          if (e.target.value !== "" && !Number.isNaN(v) && v >= min && v <= max) onChange(v);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
        className="w-full min-w-0 bg-transparent text-[13px] tabular-nums text-ink-primary outline-none"
      />
      {suffix && <span className="text-[11px] text-ink-muted">{suffix}</span>}
    </label>
  );
}

/** Swatches + "default" + a free color picker. `value` null = theme default. */
function ColorField({ value, onChange, allowTransparent, defaultLabel = "Theme" }: {
  value: string | null;
  onChange: (v: string | null) => void;
  allowTransparent?: boolean;
  defaultLabel?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        onClick={() => onChange(null)}
        aria-pressed={value === null}
        className={cn(
          "h-6 cursor-pointer rounded-full border px-2 text-[11px] transition-colors",
          value === null ? "border-accent text-ink-primary" : "border-border text-ink-muted hover:text-ink-primary"
        )}
      >
        {defaultLabel}
      </button>
      {allowTransparent && (
        <button
          onClick={() => onChange("transparent")}
          aria-label="Transparent"
          aria-pressed={value === "transparent"}
          title="Transparent"
          className={cn(
            "h-6 w-6 cursor-pointer rounded-full border bg-[repeating-conic-gradient(var(--border-strong)_0_25%,transparent_0_50%)] bg-[length:8px_8px]",
            value === "transparent" ? "ring-2 ring-accent ring-offset-1 ring-offset-surface" : "border-border"
          )}
        />
      )}
      {PALETTE_SWATCHES.slice(0, 9).map((c) => (
        <button
          key={c}
          onClick={() => onChange(c)}
          aria-label={`Color ${c}`}
          aria-pressed={value === c}
          className={cn(
            "h-6 w-6 cursor-pointer rounded-full border border-border transition-transform hover:scale-110",
            value === c && "ring-2 ring-accent ring-offset-1 ring-offset-surface"
          )}
          style={{ background: c }}
        />
      ))}
      <label
        title="Custom color"
        className="relative h-6 w-6 cursor-pointer overflow-hidden rounded-full border border-border bg-[conic-gradient(#e34948,#eda100,#1baf7a,#2a78d6,#4a3aa7,#e87ba4,#e34948)]"
      >
        <input
          type="color"
          aria-label="Custom color"
          value={value && value.startsWith("#") ? value : "#ff6b2c"}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 cursor-pointer opacity-0"
        />
      </label>
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: { value: T; icon: typeof Hash; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="flex rounded-lg border border-border bg-sunken p-0.5" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          aria-label={o.label}
          title={o.label}
          onClick={() => onChange(o.value)}
          className={cn(
            "flex h-7 flex-1 cursor-pointer items-center justify-center rounded-md transition-colors",
            value === o.value ? "bg-surface-raised text-accent shadow-sm" : "text-ink-muted hover:text-ink-primary"
          )}
        >
          <o.icon size={14} />
        </button>
      ))}
    </div>
  );
}

/* ---- shared: the visual's container ------------------------------------ */

function ContainerSection({ item, set }: { item: DashboardItem; set: (p: Partial<TileConfig>) => void }) {
  const f = frame(item);
  return (
    <Section title="Container">
      <Field label="Background">
        <ColorField value={item.config.background} onChange={(v) => set({ background: v })} allowTransparent />
      </Field>
      <Toggle label="Border" checked={f.border} onChange={(v) => set({ border: v })} />
      <Toggle label="Shadow" checked={f.shadow} onChange={(v) => set({ shadow: v })} />
      <div className="grid grid-cols-2 gap-2">
        <Field label="Corner radius">
          <NumberInput label="Corner radius" value={f.radius} min={0} max={48} suffix="px" onChange={(v) => set({ radius: v })} />
        </Field>
        <Field label="Padding">
          <NumberInput label="Padding" value={f.padding} min={0} max={64} suffix="px" onChange={(v) => set({ padding: v })} />
        </Field>
      </div>
    </Section>
  );
}

/* ---- panes ------------------------------------------------------------- */

function ChartFormat({ item, onConfig }: { item: DashboardItem; onConfig: (c: TileConfig) => void }) {
  const cfg = item.config;
  const set = (p: Partial<TileConfig>) => onConfig({ ...cfg, ...p });
  const current = cfg.display_type ?? item.chart.chart_type;
  const types = item.rows ? compatibleDisplayTypes(item.chart, item.rows) : (["table"] as DisplayType[]);

  return (
    <>
      <Section title="Visual type">
        <div className="grid grid-cols-4 gap-1.5" role="radiogroup" aria-label="Display type">
          {types.map((t) => {
            const Icon = ICONS[t];
            const on = t === current;
            return (
              <button
                key={t}
                role="radio"
                aria-checked={on}
                aria-label={DISPLAY_LABELS[t]}
                onClick={() => set({ display_type: t === item.chart.chart_type ? null : t })}
                className={cn(
                  "flex cursor-pointer flex-col items-center gap-1 rounded-lg border px-1 py-2 text-[11px] transition-all",
                  on ? "border-accent bg-accent-wash text-ink-primary" : "border-border text-ink-secondary hover:border-border-strong"
                )}
              >
                <Icon size={16} className={on ? "text-accent" : ""} />
                {DISPLAY_LABELS[t]}
              </button>
            );
          })}
        </div>
      </Section>
      <Section title="Title">
        <Toggle label="Show title" checked={cfg.show_title} onChange={(v) => set({ show_title: v })} />
        <input
          id="tile-title"
          aria-label="Title"
          value={cfg.title ?? ""}
          onChange={(e) => set({ title: e.target.value || null })}
          placeholder={item.question}
          maxLength={160}
          className="rounded-lg border border-border bg-sunken px-2.5 py-2 text-[13px] text-ink-primary outline-none placeholder:text-ink-muted focus:border-accent"
        />
      </Section>
      <Section title="Colors">
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Tile color">
          <button
            role="radio"
            aria-checked={cfg.color === null}
            aria-label="Automatic color"
            onClick={() => set({ color: null })}
            className={cn(
              "h-7 cursor-pointer rounded-full border px-2.5 text-[11.5px]",
              cfg.color === null ? "border-accent text-ink-primary" : "border-border text-ink-muted"
            )}
          >
            Auto
          </button>
          {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
            <button
              key={n}
              role="radio"
              aria-checked={cfg.color === n}
              aria-label={`Color ${n}`}
              onClick={() => set({ color: n })}
              className={cn(
                "h-7 w-7 cursor-pointer rounded-full transition-transform hover:scale-110",
                cfg.color === n && "ring-2 ring-ink-primary ring-offset-2 ring-offset-surface"
              )}
              style={{ background: `var(--color-series-${n})` }}
            />
          ))}
        </div>
      </Section>
      <Section title="Details">
        <Toggle label="Legend" checked={cfg.show_legend} onChange={(v) => set({ show_legend: v })} />
        <Toggle label="Insight sentence" checked={cfg.show_narration} onChange={(v) => set({ show_narration: v })} />
      </Section>
      <ContainerSection item={item} set={set} />
      <Section title="Source" defaultOpen={false}>
        <p className="text-[12.5px] leading-snug text-ink-secondary">“{item.question}”</p>
        <div className="flex items-center gap-2 text-[12px] text-ink-muted">
          <SqlButton sql={item.sql} align="left" /> The governed query behind this visual
        </div>
      </Section>
    </>
  );
}

function TextFormat({ item, onConfig }: { item: DashboardItem; onConfig: (c: TileConfig) => void }) {
  const cfg = item.config;
  const set = (p: Partial<TileConfig>) => onConfig({ ...cfg, ...p });
  return (
    <>
      <Section title="Text">
        <Field label="Font">
          <select
            aria-label="Font family"
            value={cfg.font_family}
            onChange={(e) => set({ font_family: e.target.value as FontFamily })}
            className="cursor-pointer rounded-lg border border-border bg-sunken px-2 py-2 text-[13px] text-ink-primary outline-none focus:border-accent"
          >
            {FONT_OPTIONS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Size">
            <NumberInput label="Base font size" value={cfg.font_size} min={8} max={120} suffix="px" onChange={(v) => set({ font_size: v })} />
          </Field>
          <Field label="Line height">
            <NumberInput label="Line height" value={cfg.line_height} min={1} max={2.5} step={0.05} onChange={(v) => set({ line_height: v })} />
          </Field>
        </div>
        <Field label="Color">
          <ColorField value={cfg.text_color} onChange={(v) => set({ text_color: v === "transparent" ? null : v })} />
        </Field>
        <Field label="Alignment">
          <Segmented
            label="Horizontal alignment"
            value={cfg.align}
            onChange={(v) => set({ align: v })}
            options={[
              { value: "left", icon: AlignLeft, label: "Left" },
              { value: "center", icon: AlignCenter, label: "Center" },
              { value: "right", icon: AlignRight, label: "Right" },
              { value: "justify", icon: AlignJustify, label: "Justify" },
            ]}
          />
          <Segmented
            label="Vertical alignment"
            value={cfg.valign}
            onChange={(v) => set({ valign: v })}
            options={[
              { value: "top", icon: AlignVerticalJustifyStart, label: "Top" },
              { value: "middle", icon: AlignVerticalJustifyCenter, label: "Middle" },
              { value: "bottom", icon: AlignVerticalJustifyEnd, label: "Bottom" },
            ]}
          />
        </Field>
        <p className="text-[11.5px] leading-relaxed text-ink-muted">
          Double-click the box to type. Select words to make them bold, italic, underlined, a different size
          or color from the floating toolbar.
        </p>
      </Section>
      <ContainerSection item={item} set={set} />
    </>
  );
}

function PageFormat({ page, onPage }: { page: ReportPage; onPage: (p: Partial<ReportPage>) => void }) {
  const [name, setName] = useState(page.name);
  return (
    <>
      <Section title="Page">
        <Field label="Name">
          <input
            aria-label="Page name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name !== page.name && onPage({ name: name.trim() })}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            className="rounded-lg border border-border bg-sunken px-2.5 py-2 text-[13px] text-ink-primary outline-none focus:border-accent"
          />
        </Field>
      </Section>
      <Section title="Canvas size">
        <div className="grid grid-cols-4 gap-1.5">
          {PAGE_SIZES.map((s) => (
            <button
              key={s.label}
              onClick={() => onPage({ width: s.w, height: s.h })}
              aria-pressed={page.width === s.w && page.height === s.h}
              className={cn(
                "cursor-pointer rounded-lg border px-1 py-1.5 text-[11.5px] transition-colors",
                page.width === s.w && page.height === s.h
                  ? "border-accent bg-accent-wash text-ink-primary"
                  : "border-border text-ink-secondary hover:border-border-strong"
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Width">
            <NumberInput label="Page width" value={page.width} min={320} max={4000} step={8} suffix="px" onChange={(v) => onPage({ width: v })} />
          </Field>
          <Field label="Height">
            <NumberInput label="Page height" value={page.height} min={240} max={8000} step={8} suffix="px" onChange={(v) => onPage({ height: v })} />
          </Field>
        </div>
      </Section>
      <Section title="Canvas background">
        <ColorField value={page.background} onChange={(v) => onPage({ background: v })} />
      </Section>
      <p className="px-4 py-4 text-[11.5px] leading-relaxed text-ink-muted">
        Select a visual to format it. Drag to move — it snaps to the grid and to other visuals&apos; edges and
        centers. Arrow keys nudge, Shift+arrow by 8px, ⌫ deletes, Ctrl+D duplicates.
      </p>
    </>
  );
}

export function FormatPane({
  page,
  selected,
  onPage,
  onConfig,
}: {
  page: ReportPage;
  selected: DashboardItem | null;
  onPage: (patch: Partial<ReportPage>) => void;
  onConfig: (id: string, config: TileConfig) => void;
}) {
  const title = !selected ? "Format page" : selected.kind === "text" ? "Format text box" : "Format visual";
  return (
    <aside
      aria-label="Format pane"
      className="flex w-[300px] shrink-0 flex-col border-l border-border bg-surface"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <header className="border-b border-border px-4 py-3">
        <span className="kicker">Format</span>
        <p className="mt-0.5 text-[15px] font-semibold tracking-tight text-ink-primary">{title}</p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!selected ? (
          <PageFormat key={page.id} page={page} onPage={onPage} />
        ) : selected.kind === "text" ? (
          <TextFormat key={selected.id} item={selected} onConfig={(c) => onConfig(selected.id, c)} />
        ) : (
          <ChartFormat key={selected.id} item={selected} onConfig={(c) => onConfig(selected.id, c)} />
        )}
      </div>
    </aside>
  );
}
