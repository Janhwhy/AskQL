"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FocusModal } from "@/components/report/FocusModal";
import { FormatPane } from "@/components/report/FormatPane";
import type { Rect } from "@/components/report/geometry";
import { clearInlineStyle, stripInlineStyleHtml } from "@/components/report/richtext";
import { PageTabs } from "@/components/report/PageTabs";
import { ReportCanvas, type Zoom } from "@/components/report/ReportCanvas";
import { Ribbon } from "@/components/report/Ribbon";
import {
  addPage,
  addTextBox,
  deletePage,
  duplicateItem,
  getDashboard,
  removeDashboardItem,
  updateDashboard,
  updateItem,
  updateLayout,
  updatePage,
} from "@/lib/dashboardApi";
import type { Dashboard, DashboardItem, ReportPage, TileConfig } from "@/lib/types";

/**
 * A dashboard is a Power BI-style REPORT (Phase 8b): pages of fixed size,
 * each a free-form canvas of visuals and text boxes. Every edit is applied
 * locally first and persisted in the background; a failed save reloads the
 * report from the server, which stays the source of truth.
 */
export default function ReportPageView() {
  const { id } = useParams<{ id: string }>();
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageId, setPageId] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [scale, setScale] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingRef = useRef<string | null>(null);
  useEffect(() => {
    editingRef.current = editingId;
  }, [editingId]);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const pendingText = useRef<{ id: string; html: string } | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const onEditor = useCallback((el: HTMLDivElement | null) => {
    editorRef.current = el;
  }, []);
  const dashRef = useRef<Dashboard | null>(null);
  useEffect(() => {
    dashRef.current = dashboard;
  }, [dashboard]);

  const load = useCallback(() => {
    return getDashboard(id)
      .then((d) => {
        setDashboard(d);
        setError(null);
        setPageId((cur) => (cur && d.pages.some((p) => p.id === cur) ? cur : d.pages[0]?.id ?? null));
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load this dashboard."));
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const debounce = (key: string, fn: () => void, ms = 350) => {
    clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(fn, ms);
  };

  const patchItem = useCallback(
    (itemId: string, fn: (i: DashboardItem) => DashboardItem) =>
      setDashboard((prev) => (prev ? { ...prev, items: prev.items.map((i) => (i.id === itemId ? fn(i) : i)) } : prev)),
    []
  );

  const page = dashboard?.pages.find((p) => p.id === pageId) ?? dashboard?.pages[0] ?? null;
  const pageItems = useMemo(
    () => (dashboard && page ? dashboard.items.filter((i) => i.page_id === page.id) : []),
    [dashboard, page]
  );
  const selected = pageItems.find((i) => i.id === selectedId) ?? null;

  /* ---- text ---- */
  const flushText = useCallback(() => {
    const p = pendingText.current;
    if (!p) return;
    pendingText.current = null;
    clearTimeout(timers.current[`text-${p.id}`]);
    patchItem(p.id, (i) => ({ ...i, text: p.html, config: { ...i.config, text_format: "html" } }));
    updateItem(id, p.id, { text: p.html }).catch(() => void load());
  }, [id, load, patchItem]);

  // Never lose the last few hundred ms of typing/formatting: flush on
  // unmount (navigating away inside the app) and on pagehide (closing the
  // tab), with keepalive so the request survives the page going away.
  useEffect(() => {
    const finalFlush = () => {
      const p = pendingText.current;
      if (!p) return;
      pendingText.current = null;
      updateItem(id, p.id, { text: p.html }, { keepalive: true }).catch(() => {});
    };
    window.addEventListener("pagehide", finalFlush);
    return () => {
      window.removeEventListener("pagehide", finalFlush);
      finalFlush();
    };
  }, [id]);

  const onTextInput = useCallback(
    (itemId: string, html: string) => {
      pendingText.current = { id: itemId, html };
      // autosave while typing, without re-rendering the canvas per keystroke
      clearTimeout(timers.current[`text-${itemId}`]);
      timers.current[`text-${itemId}`] = setTimeout(() => {
        if (pendingText.current?.id === itemId) {
          updateItem(id, itemId, { text: pendingText.current.html }).catch(() => {});
        }
      }, 450);
    },
    [id]
  );

  const onEditText = useCallback(
    (itemId: string | null) => {
      flushText();
      setEditingId(itemId);
      if (itemId) setSelectedId(itemId);
    },
    [flushText]
  );

  /* ---- layout ---- */
  const onCommitLayout = useCallback(
    (itemId: string, rect: Rect) => {
      const item = dashRef.current?.items.find((i) => i.id === itemId);
      if (!item) return;
      // Guide snaps can land on half pixels (centering an odd width); the
      // API stores integer page px and rightly 422s anything else.
      const layout = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.w),
        h: Math.round(rect.h),
        z: item.layout.z,
      };
      patchItem(itemId, (i) => ({ ...i, layout }));
      updateLayout(id, [{ id: itemId, ...layout }]).catch(() => void load());
    },
    [id, load, patchItem]
  );

  const onArrange = useCallback(
    (itemId: string, dir: "front" | "back") => {
      const d = dashRef.current;
      const item = d?.items.find((i) => i.id === itemId);
      if (!d || !item) return;
      const zs = d.items.filter((i) => i.page_id === item.page_id).map((i) => i.layout.z);
      const z = dir === "front" ? Math.max(...zs) + 1 : Math.min(...zs) - 1;
      const layout = { ...item.layout, z };
      patchItem(itemId, (i) => ({ ...i, layout }));
      updateLayout(id, [{ id: itemId, ...layout }]).catch(() => void load());
    },
    [id, load, patchItem]
  );

  /* ---- items ---- */
  const onConfig = useCallback(
    (itemId: string, config: TileConfig) => {
      const prev = dashRef.current?.items.find((i) => i.id === itemId);
      patchItem(itemId, (i) => ({ ...i, config }));
      debounce(`cfg-${itemId}`, () => {
        updateItem(id, itemId, { config }).catch(() => void load());
      });

      // A box-level size/color/font change must apply to the WHOLE box.
      // Real bug: words that had been sized/colored individually kept
      // their inline override, so "make the text 32px" changed only some
      // of it. Clear that one property from every per-word span -- in the
      // live editor if this box is being edited, else in the stored HTML.
      if (!prev || prev.kind !== "text") return;
      const changed = (
        [
          ["font_size", "font-size"],
          ["text_color", "color"],
          ["font_family", "font-family"],
        ] as const
      ).filter(([k]) => prev.config[k] !== config[k]);
      if (changed.length === 0) return;
      const ed = editorRef.current;
      if (ed && editingRef.current === itemId) {
        changed.forEach(([, css]) => clearInlineStyle(ed, css));
        ed.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (prev.text && prev.config.text_format === "html") {
        let html = prev.text;
        changed.forEach(([, css]) => (html = stripInlineStyleHtml(html, css)));
        if (html !== prev.text) {
          patchItem(itemId, (i) => ({ ...i, text: html }));
          updateItem(id, itemId, { text: html }).catch(() => void load());
        }
      }
    },
    [id, load, patchItem]
  );

  const onDuplicate = useCallback(
    async (itemId: string) => {
      flushText();
      try {
        const copy = await duplicateItem(id, itemId);
        setDashboard((prev) => (prev ? { ...prev, items: [...prev.items, copy] } : prev));
        setSelectedId(copy.id);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't duplicate that visual.");
      }
    },
    [id, flushText]
  );

  const onDelete = useCallback(
    async (itemId: string) => {
      setSelectedId(null);
      setEditingId(null);
      pendingText.current = null;
      setDashboard((prev) => (prev ? { ...prev, items: prev.items.filter((i) => i.id !== itemId) } : prev));
      try {
        await removeDashboardItem(id, itemId);
      } catch {
        void load();
      }
    },
    [id, load]
  );

  async function onAddText() {
    if (!page) return;
    const box = await addTextBox(id, { text: "", page_id: page.id });
    setDashboard((prev) => (prev ? { ...prev, items: [...prev.items, box] } : prev));
    setSelectedId(box.id);
    setEditingId(box.id);
  }

  function onVisualAdded(item: DashboardItem) {
    setDashboard((prev) => (prev ? { ...prev, items: [...prev.items, item] } : prev));
    setSelectedId(item.id);
    // auto-placement may have grown the page to fit it
    void load();
  }

  /* ---- pages ---- */
  function onPage(patch: Partial<ReportPage>) {
    if (!page) return;
    const pid = page.id;
    setDashboard((prev) =>
      prev ? { ...prev, pages: prev.pages.map((p) => (p.id === pid ? { ...p, ...patch } : p)) } : prev
    );
    const body =
      "background" in patch && patch.background === null
        ? { ...patch, background: undefined, reset_background: true }
        : { ...patch, background: patch.background ?? undefined };
    debounce(`page-${pid}`, () => {
      updatePage(id, pid, body).catch(() => void load());
    }, 400);
  }

  async function onAddPage() {
    const p = await addPage(id);
    setDashboard((prev) => (prev ? { ...prev, pages: [...prev.pages, p] } : prev));
    setPageId(p.id);
    setSelectedId(null);
  }

  async function onDeletePage(pid: string) {
    setDashboard((prev) =>
      prev
        ? { ...prev, pages: prev.pages.filter((p) => p.id !== pid), items: prev.items.filter((i) => i.page_id !== pid) }
        : prev
    );
    if (pid === page?.id) setPageId(dashboard?.pages.find((p) => p.id !== pid)?.id ?? null);
    try {
      await deletePage(id, pid);
    } catch {
      void load();
    }
  }

  function onRenamePage(pid: string, name: string) {
    setDashboard((prev) => (prev ? { ...prev, pages: prev.pages.map((p) => (p.id === pid ? { ...p, name } : p)) } : prev));
    updatePage(id, pid, { name }).catch(() => void load());
  }

  function switchMode(edit: boolean) {
    flushText();
    setEditMode(edit);
    setEditingId(null);
    if (!edit) setSelectedId(null);
    setZoom("fit");
  }

  async function onRefresh() {
    flushText();
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  const focusItem = dashboard?.items.find((i) => i.id === focusId) ?? null;

  if (error && !dashboard) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center">
        <div>
          <p className="text-2xl font-semibold tracking-tight text-ink-primary">This dashboard couldn&apos;t load.</p>
          <p className="mt-2 text-sm text-ink-muted">{error}</p>
        </div>
      </div>
    );
  }

  if (!dashboard || !page) {
    return (
      <div className="flex h-full flex-col">
        <div className="h-[53px] border-b border-border" />
        <div className="workspace flex flex-1 items-center justify-center">
          <div className="shimmer aspect-video w-[min(70%,900px)] rounded-lg bg-surface/70" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Ribbon
        dashboardId={id}
        pageId={page.id}
        name={dashboard.name}
        onRename={(name) => {
          setDashboard((prev) => (prev ? { ...prev, name } : prev));
          updateDashboard(id, { name }).catch(() => void load());
        }}
        editMode={editMode}
        onMode={switchMode}
        selected={selected}
        onAddText={onAddText}
        onVisualAdded={onVisualAdded}
        onDuplicate={() => selected && onDuplicate(selected.id)}
        onDelete={() => selected && onDelete(selected.id)}
        onArrange={(dir) => selected && onArrange(selected.id, dir)}
        zoom={zoom}
        scale={scale}
        onZoom={setZoom}
        onRefresh={onRefresh}
        refreshing={refreshing}
      />
      {error && <p className="bg-status-critical/10 px-4 py-1.5 text-[12.5px] text-status-critical">{error}</p>}

      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col">
          <ReportCanvas
            page={page}
            items={pageItems}
            editMode={editMode}
            zoom={zoom}
            selectedId={selectedId}
            editingId={editingId}
            onSelect={setSelectedId}
            onEditText={onEditText}
            onCommitLayout={onCommitLayout}
            onTextInput={onTextInput}
            onConfig={onConfig}
            onDuplicate={onDuplicate}
            onDelete={onDelete}
            onArrange={onArrange}
            onFocusVisual={setFocusId}
            onScale={setScale}
            onEditor={onEditor}
          />
          {pageItems.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="animate-rise max-w-sm rounded-2xl px-6 py-5 text-center">
                <p className="text-[20px] font-semibold tracking-tight text-ink-primary">A blank page.</p>
                <p className="mt-1.5 text-[13px] text-ink-muted">
                  {editMode
                    ? "Insert a text box, or “Ask a visual” and the answer lands right here."
                    : "Switch to Edit to add visuals and text."}
                </p>
              </div>
            </div>
          )}
        </div>
        {editMode && (
          <FormatPane page={page} selected={selected} onPage={onPage} onConfig={onConfig} />
        )}
      </div>

      <PageTabs
        pages={dashboard.pages}
        activeId={page.id}
        editMode={editMode}
        onSelect={(pid) => {
          flushText();
          setPageId(pid);
          setSelectedId(null);
          setEditingId(null);
        }}
        onAdd={onAddPage}
        onRename={onRenamePage}
        onDelete={onDeletePage}
      />

      {focusItem && <FocusModal item={focusItem} onClose={() => setFocusId(null)} />}
    </div>
  );
}
