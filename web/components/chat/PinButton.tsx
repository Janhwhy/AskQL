"use client";

import { Check, Pin, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createDashboard, listDashboards, pinChart } from "@/lib/dashboardApi";
import type { ChartDecision, DashboardSummary } from "@/lib/types";

export function PinButton({
  question,
  sql,
  chart,
  narration,
}: {
  question: string;
  sql: string;
  chart: ChartDecision;
  narration: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [dashboards, setDashboards] = useState<DashboardSummary[] | null>(null);
  const [newName, setNewName] = useState("");
  const [pinnedTo, setPinnedTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    listDashboards()
      .then(setDashboards)
      .catch(() => setError("Couldn't load dashboards."));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  async function pinTo(dashboardId: string, dashboardName: string) {
    setBusy(true);
    setError(null);
    try {
      await pinChart(dashboardId, { question, sql, chart, narration });
      setPinnedTo(dashboardName);
      setTimeout(() => setOpen(false), 900);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't pin this chart.");
    } finally {
      setBusy(false);
    }
  }

  async function createAndPin() {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const dashboard = await createDashboard(name);
      await pinTo(dashboard.id, dashboard.name);
      setNewName("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create dashboard.");
      setBusy(false);
    }
  }

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        onClick={() => {
          setPinnedTo(null);
          setError(null);
          setOpen((v) => !v);
        }}
        className="flex cursor-pointer items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-ink-secondary transition-colors hover:border-accent hover:text-accent"
      >
        <Pin size={12} />
        Pin to dashboard
      </button>

      {open && (
        <div className="animate-fade-up absolute right-0 z-10 mt-2 w-64 rounded-xl border border-border-strong bg-surface-raised p-2 shadow-lg">
          {pinnedTo ? (
            <div className="flex items-center gap-2 px-2 py-3 text-sm text-status-good">
              <Check size={16} />
              Pinned to “{pinnedTo}”
            </div>
          ) : (
            <>
              <p className="px-2 pb-1.5 pt-1 text-xs font-medium text-ink-muted">
                Pin to a dashboard
              </p>
              <div className="max-h-48 overflow-y-auto">
                {dashboards === null && (
                  <p className="px-2 py-2 text-xs text-ink-muted">Loading…</p>
                )}
                {dashboards?.length === 0 && (
                  <p className="px-2 py-2 text-xs text-ink-muted">No dashboards yet.</p>
                )}
                {dashboards?.map((d) => (
                  <button
                    key={d.id}
                    disabled={busy}
                    onClick={() => pinTo(d.id, d.name)}
                    className="flex w-full cursor-pointer items-center justify-between rounded-lg px-2 py-1.5 text-left text-sm text-ink-primary transition-colors hover:bg-accent-wash disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className="truncate">{d.name}</span>
                    <span className="shrink-0 text-xs text-ink-muted">{d.item_count}</span>
                  </button>
                ))}
              </div>
              <div className="mt-1 flex items-center gap-1 border-t border-border pt-2">
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && createAndPin()}
                  placeholder="New dashboard name"
                  disabled={busy}
                  className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-ink-primary outline-none focus:border-accent"
                />
                <button
                  onClick={createAndPin}
                  disabled={busy || !newName.trim()}
                  aria-label="Create dashboard and pin"
                  className="shrink-0 cursor-pointer rounded-lg border border-border p-1.5 text-ink-secondary transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Plus size={14} />
                </button>
              </div>
              {error && <p className="px-2 pt-1.5 text-xs text-status-critical">{error}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
