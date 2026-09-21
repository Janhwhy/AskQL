"use client";

import { ArrowLeft, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { Layout } from "react-grid-layout";
import { Header } from "@/components/Header";
import { DashboardGrid } from "@/components/dashboards/DashboardGrid";
import { getDashboard, removeDashboardItem, updateLayout } from "@/lib/dashboardApi";
import type { Dashboard } from "@/lib/types";

export default function DashboardDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => {
    return getDashboard(id)
      .then((d) => {
        setDashboard(d);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load this dashboard."));
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  // Optimistic locally, persisted in the background -- a dragged/resized
  // tile should feel instant, not wait on a round trip before settling.
  function handleLayoutChange(layout: Layout[]) {
    if (!dashboard) return;
    setDashboard((prev) =>
      prev
        ? {
            ...prev,
            items: prev.items.map((item) => {
              const l = layout.find((entry) => entry.i === item.id);
              return l ? { ...item, layout: { x: l.x, y: l.y, w: l.w, h: l.h } } : item;
            }),
          }
        : prev
    );
    const items = layout.map((l) => ({ id: l.i, x: l.x, y: l.y, w: l.w, h: l.h }));
    updateLayout(id, items).catch(() => {
      // Layout persistence failing is low-stakes (worst case: a rearrange
      // gets lost on next load) -- don't interrupt the user with an error
      // for a drag they already saw complete visually.
    });
  }

  async function handleRemove(itemId: string) {
    setDashboard((prev) => (prev ? { ...prev, items: prev.items.filter((i) => i.id !== itemId) } : prev));
    try {
      await removeDashboardItem(id, itemId);
    } catch {
      void load();
    }
  }

  return (
    <div className="flex h-full flex-col bg-plane">
      <Header />
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8">
        <div className="mx-auto flex max-w-6xl flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <Link
                href="/dashboards"
                className="rounded-full p-1.5 text-ink-muted transition-colors hover:bg-surface-raised hover:text-ink-primary"
              >
                <ArrowLeft size={16} />
              </Link>
              <h1 className="text-lg font-semibold tracking-tight text-ink-primary">
                {dashboard?.name ?? "Dashboard"}
              </h1>
            </div>
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="flex cursor-pointer items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs text-ink-secondary transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed"
            >
              <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} />
              Refresh
            </button>
          </div>

          {error && <p className="text-sm text-status-critical">{error}</p>}
          {!dashboard && !error && <p className="text-sm text-ink-muted">Loading…</p>}

          {dashboard && dashboard.items.length === 0 && (
            <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border py-16 text-center">
              <p className="text-sm text-ink-muted">
                No charts pinned yet — ask a question in the chat, then pin the answer here.
              </p>
            </div>
          )}

          {dashboard && dashboard.items.length > 0 && (
            <DashboardGrid items={dashboard.items} onLayoutChange={handleLayoutChange} onRemove={handleRemove} />
          )}
        </div>
      </main>
    </div>
  );
}
