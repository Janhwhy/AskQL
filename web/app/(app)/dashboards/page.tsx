"use client";

import { ArrowUpRight, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { createDashboard, deleteDashboard, listDashboards } from "@/lib/dashboardApi";
import type { DashboardSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Each dashboard's real tile layout, drawn as a blueprint -- you recognize
 * your dashboard by its shape before you read its name. */
function Blueprint({ thumb, page }: { thumb: NonNullable<DashboardSummary["thumb"]>; page: { w: number; h: number } }) {
  // The report's real first page, in proportion: page outline + every
  // visual's rectangle (dashed = text box).
  return (
    <svg viewBox={`-8 -8 ${page.w + 16} ${page.h + 16}`} preserveAspectRatio="xMidYMid meet" className="h-full w-full" aria-hidden="true">
      <rect x={0} y={0} width={page.w} height={page.h} rx={10} fill="var(--plane)" stroke="var(--border-strong)" strokeWidth={3} />
      {thumb.length === 0 && (
        <text x={page.w / 2} y={page.h / 2} textAnchor="middle" dominantBaseline="middle" fontSize={page.w / 22} fill="var(--ink-muted)">
          Empty page
        </text>
      )}
      {thumb.map((t, i) => (
        <rect
          key={i}
          x={t.x}
          y={t.y}
          width={t.w}
          height={t.h}
          rx={12}
          fill={t.kind === "text" ? "transparent" : "var(--surface-raised)"}
          stroke={i === 0 ? "var(--accent)" : "var(--border-strong)"}
          strokeWidth={4}
          strokeDasharray={t.kind === "text" ? "14 10" : undefined}
        />
      ))}
    </svg>
  );
}

export default function DashboardsPage() {
  const [dashboards, setDashboards] = useState<DashboardSummary[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  function refresh() {
    listDashboards()
      .then(setDashboards)
      .catch(() => setError("Couldn't load dashboards."));
  }

  useEffect(refresh, []);

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await createDashboard(trimmed);
      setName("");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create dashboard.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: string) {
    setConfirming(null);
    setDashboards((prev) => prev?.filter((d) => d.id !== id) ?? prev);
    try {
      await deleteDashboard(id);
    } catch {
      refresh();
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-10 px-5 pt-10 pb-24 sm:px-10">
        <header className="animate-rise flex flex-wrap items-end justify-between gap-6">
          <div className="flex flex-col gap-3">
            <span className="kicker">Workspace</span>
            <h1 className="font-display text-[clamp(2.8rem,6vw,4.6rem)] leading-[0.95] text-ink-primary">
              Dashboards<span className="beam-text">.</span>
            </h1>
            <p className="max-w-[52ch] text-[15px] text-ink-secondary">
              Pinned answers, arranged your way. Every visual re-runs its query on open, so you
              always see today&apos;s numbers.
            </p>
          </div>

          <div className="panel flex w-full items-center gap-2 rounded-2xl p-1.5 pl-4 sm:w-auto">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              placeholder="Name a new dashboard"
              aria-label="New dashboard name"
              disabled={busy}
              className="min-w-0 flex-1 bg-transparent text-[14px] text-ink-primary outline-none placeholder:text-ink-muted sm:w-56"
            />
            <button
              onClick={handleCreate}
              disabled={busy || !name.trim()}
              className="beam-gradient flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl px-3.5 py-2 text-[13px] font-medium text-accent-ink transition-opacity disabled:cursor-not-allowed disabled:[background:var(--border-strong)] disabled:text-ink-muted"
            >
              <Plus size={14} />
              Create
            </button>
          </div>
        </header>

        {error && <p className="text-sm text-status-critical">{error}</p>}

        {dashboards === null ? (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-72 animate-pulse rounded-[24px] bg-surface/70" />
            ))}
          </div>
        ) : dashboards.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-[28px] border border-dashed border-border-strong px-6 py-24 text-center">
            <p className="font-display text-4xl text-ink-primary">Nothing pinned yet.</p>
            <p className="max-w-md text-sm text-ink-muted">
              Name a dashboard above, or ask a question in the chat and hit “Pin to dashboard” on the answer.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {dashboards.map((d, i) => (
              <Link
                key={d.id}
                href={`/dashboards/${d.id}`}
                style={{ animationDelay: `${i * 50}ms` }}
                className="group panel animate-rise relative flex flex-col overflow-hidden rounded-[24px] transition-all hover:-translate-y-0.5 hover:border-border-strong"
              >
                <div className="observatory-canvas relative h-44 border-b border-border p-5">
                  <Blueprint thumb={d.thumb ?? []} page={d.thumb_page ?? { w: 1280, h: 720 }} />
                  <span className="beam-gradient absolute bottom-0 left-0 h-px w-0 transition-all duration-500 group-hover:w-full" />
                </div>
                <div className="flex items-start justify-between gap-3 p-5">
                  <div className="flex min-w-0 flex-col gap-1">
                    <h2 className="font-display truncate text-[1.6rem] leading-tight text-ink-primary">{d.name}</h2>
                    {d.description && <p className="line-clamp-1 text-[13px] text-ink-secondary">{d.description}</p>}
                    <span className="kicker mt-1">
                      {d.item_count} visual{d.item_count === 1 ? "" : "s"} ·{" "}
                      {new Date(d.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    </span>
                  </div>
                  <ArrowUpRight
                    size={18}
                    className="mt-1 shrink-0 text-ink-muted transition-all group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-accent"
                  />
                </div>
                <div
                  className={cn(
                    "absolute top-3 right-3 flex items-center gap-1 transition-opacity",
                    confirming === d.id ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                  )}
                  onClick={(e) => e.preventDefault()}
                >
                  {confirming === d.id ? (
                    <>
                      <button
                        onClick={() => handleDelete(d.id)}
                        className="cursor-pointer rounded-lg bg-status-critical px-2.5 py-1 text-xs font-medium text-white"
                      >
                        Delete
                      </button>
                      <button
                        onClick={() => setConfirming(null)}
                        className="cursor-pointer rounded-lg border border-border bg-surface px-2.5 py-1 text-xs text-ink-secondary"
                      >
                        Keep
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setConfirming(d.id)}
                      title="Delete dashboard"
                      aria-label={`Delete ${d.name}`}
                      className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border border-border bg-surface text-ink-muted hover:text-status-critical"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
