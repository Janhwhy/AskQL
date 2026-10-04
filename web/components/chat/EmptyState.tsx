"use client";

import { ArrowUpRight } from "lucide-react";
import { useEffect, useState } from "react";
import { getStats } from "@/lib/chatApi";

const PROMPTS = [
  { kicker: "Revenue", text: "Show me daily revenue for the last 14 days" },
  { kicker: "Mix", text: "Pie chart of revenue by region" },
  { kicker: "Customers", text: "How many active customers do we have by plan tier?" },
  { kicker: "Products", text: "Table of top 10 products by revenue" },
  { kicker: "Support", text: "How's support doing?" },
  { kicker: "Pulse", text: "What was total revenue yesterday?" },
];

const STAT_LABELS: [key: string, label: string][] = [
  ["sales", "sales recorded"],
  ["customers", "customers"],
  ["support_tickets", "support tickets"],
  ["products", "products"],
];

function compact(n: number) {
  return n.toLocaleString(undefined, { notation: n >= 100_000 ? "compact" : "standard", maximumFractionDigits: 1 });
}

export function EmptyState({ onPick }: { onPick: (question: string) => void }) {
  const [stats, setStats] = useState<Record<string, number> | null>(null);

  useEffect(() => {
    getStats()
      .then(setStats)
      .catch(() => setStats(null));
  }, []);

  return (
    <div className="flex flex-col gap-14 pt-[6vh]">
      <header className="animate-rise flex flex-col gap-5">
        <span className="kicker flex items-center gap-2">
          <span className="beam-gradient inline-block h-[5px] w-[5px] rounded-full shadow-[0_0_8px_var(--glow)]" />
          Analytics in plain English
        </span>
        <h1 className="font-display text-[clamp(2.7rem,6.5vw,5rem)] leading-[0.98] text-ink-primary">
          Ask the business
          <br />
          <span className="beam-text">anything.</span>
        </h1>
        <p className="max-w-[46ch] text-[15.5px] leading-relaxed text-ink-secondary">
          Plain-English questions, answered against a governed set of metrics. Every number arrives with
          the chart, the insight, and the exact SQL behind it. Follow up naturally — “now by region”, “as a
          table” — and the conversation keeps up.
        </p>
      </header>

      {/* live instrument readout — the real size of what you're querying */}
      <dl className="animate-rise grid grid-cols-2 border-y border-border [animation-delay:80ms] sm:grid-cols-4">
        {STAT_LABELS.map(([key, label]) => (
          <div
            key={key}
            className="flex flex-col gap-1 border-l border-border py-4 pl-5 first:border-l-0 first:pl-0 [&:nth-child(3)]:border-l-0 [&:nth-child(3)]:pl-0 sm:[&:nth-child(3)]:border-l sm:[&:nth-child(3)]:pl-5"
          >
            <dt className="kicker order-2">{label}</dt>
            <dd className="order-1 text-[24px] font-semibold tabular-nums tracking-tight text-ink-primary">
              {stats?.[key] != null ? compact(stats[key]) : "—"}
            </dd>
          </div>
        ))}
      </dl>

      <section className="animate-rise [animation-delay:160ms]">
        <h2 className="kicker mb-4">Try one</h2>
        <div className="grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
          {PROMPTS.map(({ kicker, text }, i) => (
            <button
              key={text}
              onClick={() => onPick(text)}
              className="group relative flex min-h-[112px] cursor-pointer flex-col justify-between gap-4 bg-surface p-4 text-left transition-colors hover:bg-surface-raised"
            >
              <span className="flex items-center justify-between">
                <span className="kicker">
                  {String(i + 1).padStart(2, "0")} — {kicker}
                </span>
                <ArrowUpRight
                  size={15}
                  className="text-ink-muted transition-all group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-accent"
                />
              </span>
              <span className="text-[14.5px] leading-snug text-ink-primary">{text}</span>
              <span className="beam-gradient absolute bottom-0 left-0 h-px w-0 transition-all duration-500 group-hover:w-full" />
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
