"use client";

import { LayoutGrid, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Header } from "@/components/Header";
import { createDashboard, deleteDashboard, listDashboards } from "@/lib/dashboardApi";
import type { DashboardSummary } from "@/lib/types";

export default function DashboardsPage() {
  const [dashboards, setDashboards] = useState<DashboardSummary[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    setDashboards((prev) => prev?.filter((d) => d.id !== id) ?? prev);
    try {
      await deleteDashboard(id);
    } catch {
      refresh();
    }
  }

  return (
    <div className="flex h-full flex-col bg-plane">
      <Header />
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-8 sm:px-8">
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-ink-primary">Dashboards</h1>
            <p className="mt-1 text-sm text-ink-muted">
              Charts pinned from the chat, arranged and kept live.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              placeholder="New dashboard name"
              disabled={busy}
              className="min-w-0 flex-1 rounded-xl border border-border bg-surface px-3.5 py-2.5 text-sm text-ink-primary outline-none focus:border-accent"
            />
            <button
              onClick={handleCreate}
              disabled={busy || !name.trim()}
              className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl bg-accent px-3.5 py-2.5 text-sm font-medium text-accent-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus size={15} />
              Create
            </button>
          </div>
          {error && <p className="text-sm text-status-critical">{error}</p>}

          {dashboards === null ? (
            <p className="text-sm text-ink-muted">Loading…</p>
          ) : dashboards.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border py-16 text-center">
              <LayoutGrid size={22} className="text-ink-muted" />
              <p className="text-sm text-ink-muted">
                No dashboards yet — pin a chart from the chat to start one.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {dashboards.map((d) => (
                <Link
                  key={d.id}
                  href={`/dashboards/${d.id}`}
                  className="group flex flex-col gap-1 rounded-2xl border border-border bg-surface p-4 transition-colors hover:border-accent"
                >
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="font-medium text-ink-primary">{d.name}</h2>
                    <button
                      onClick={(e) => {
                        e.preventDefault();
                        handleDelete(d.id);
                      }}
                      title="Delete dashboard"
                      className="shrink-0 cursor-pointer rounded-full p-1 text-ink-muted opacity-0 transition-opacity hover:bg-status-critical/10 hover:text-status-critical group-hover:opacity-100"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <p className="text-xs text-ink-muted">
                    {d.item_count} chart{d.item_count === 1 ? "" : "s"}
                  </p>
                </Link>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
