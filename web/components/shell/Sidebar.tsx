"use client";

import {
  Check,
  LayoutGrid,
  MessageSquareText,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { ChatSummary } from "@/lib/types";
import { ThemeToggle } from "@/components/ThemeToggle";
import { BrandMark } from "./BrandMark";
import { useChats } from "./ChatsProvider";

function NavLink({ href, active, icon: Icon, children }: {
  href: string;
  active: boolean;
  icon: typeof LayoutGrid;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "group relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13.5px] transition-colors",
        active ? "bg-surface-raised text-ink-primary" : "text-ink-secondary hover:bg-surface-raised/60 hover:text-ink-primary"
      )}
    >
      {/* the beam, marking where you are */}
      <span
        className={cn(
          "beam-gradient absolute top-1/2 left-0 h-4 w-[2px] -translate-y-1/2 rounded-full transition-opacity",
          active ? "opacity-100 shadow-[0_0_10px_var(--glow)]" : "opacity-0"
        )}
      />
      <Icon size={15} className={active ? "text-accent" : "text-ink-muted group-hover:text-ink-secondary"} />
      {children}
    </Link>
  );
}

function ChatRow({ chat, active, onNavigate }: { chat: ChatSummary; active: boolean; onNavigate: () => void }) {
  const { rename, togglePin, remove } = useChats();
  const router = useRouter();
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [draft, setDraft] = useState(chat.title);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setMenu(false);
        setConfirming(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menu]);

  function commitRename() {
    const t = draft.trim();
    setEditing(false);
    if (t && t !== chat.title) void rename(chat.id, t);
    else setDraft(chat.title);
  }

  async function handleDelete() {
    setMenu(false);
    await remove(chat.id);
    if (active) router.push("/");
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1 rounded-lg bg-surface-raised px-2 py-1">
        <input
          autoFocus
          aria-label="Chat title"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") {
              setDraft(chat.title);
              setEditing(false);
            }
          }}
          onBlur={commitRename}
          className="min-w-0 flex-1 bg-transparent py-1 text-[13px] text-ink-primary outline-none"
        />
        <Check size={13} className="shrink-0 text-ink-muted" />
      </div>
    );
  }

  return (
    <div ref={rootRef} className="group/row relative" data-testid="chat-row">
      <Link
        href={`/c/${chat.id}`}
        onClick={onNavigate}
        title={chat.title}
        className={cn(
          "flex items-center gap-2 rounded-lg py-1.5 pr-8 pl-3 text-[13px] transition-colors",
          active ? "bg-surface-raised text-ink-primary" : "text-ink-secondary hover:bg-surface-raised/60 hover:text-ink-primary"
        )}
      >
        {chat.pinned && <Pin size={11} className="shrink-0 rotate-45 text-accent" />}
        <span className="truncate">{chat.title}</span>
      </Link>
      <button
        aria-label={`Chat options for ${chat.title}`}
        onClick={() => {
          setMenu((v) => !v);
          setConfirming(false);
        }}
        className={cn(
          "absolute top-1/2 right-1 flex h-6 w-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-ink-muted transition-opacity hover:bg-border hover:text-ink-primary",
          menu ? "opacity-100" : "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
        )}
      >
        <MoreHorizontal size={14} />
      </button>

      {menu && (
        <div
          role="menu"
          className="animate-fade-up panel absolute top-full right-0 z-30 mt-1 w-44 rounded-xl p-1"
        >
          {confirming ? (
            <div className="flex flex-col gap-1.5 p-2">
              <p className="text-xs text-ink-secondary">Delete this chat for good?</p>
              <div className="flex gap-1.5">
                <button
                  onClick={handleDelete}
                  className="flex-1 cursor-pointer rounded-md bg-status-critical px-2 py-1 text-xs font-medium text-white"
                >
                  Delete
                </button>
                <button
                  onClick={() => setConfirming(false)}
                  className="flex-1 cursor-pointer rounded-md border border-border px-2 py-1 text-xs text-ink-secondary hover:text-ink-primary"
                >
                  Keep
                </button>
              </div>
            </div>
          ) : (
            <>
              <MenuItem
                icon={Pencil}
                label="Rename"
                onClick={() => {
                  setMenu(false);
                  setDraft(chat.title);
                  setEditing(true);
                }}
              />
              <MenuItem
                icon={chat.pinned ? PinOff : Pin}
                label={chat.pinned ? "Unpin" : "Pin"}
                onClick={() => {
                  setMenu(false);
                  void togglePin(chat.id);
                }}
              />
              <MenuItem icon={Trash2} label="Delete" danger onClick={() => setConfirming(true)} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon: Icon, label, onClick, danger }: {
  icon: typeof Pin;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors",
        danger ? "text-status-critical hover:bg-status-critical/10" : "text-ink-secondary hover:bg-surface-raised hover:text-ink-primary"
      )}
    >
      <Icon size={13} />
      {label}
    </button>
  );
}

export function Sidebar({ onNavigate }: { onNavigate: () => void }) {
  const pathname = usePathname();
  const { chats, error } = useChats();
  const [query, setQuery] = useState("");

  const filtered = (chats ?? []).filter((c) => c.title.toLowerCase().includes(query.trim().toLowerCase()));
  const pinned = filtered.filter((c) => c.pinned);
  const recent = filtered.filter((c) => !c.pinned);
  const activeChatId = pathname.startsWith("/c/") ? pathname.slice(3) : null;
  const onAsk = pathname === "/" || pathname.startsWith("/c/");

  return (
    <aside className="flex h-full w-[276px] shrink-0 flex-col border-r border-border bg-sunken/60 backdrop-blur-xl">
      <div className="flex items-center gap-2.5 px-4 pt-5 pb-4">
        <BrandMark />
        <span className="font-display text-[20px] leading-none text-ink-primary">AskQL</span>
      </div>

      <div className="px-3">
        <Link
          href="/"
          onClick={onNavigate}
          className="group flex items-center justify-between rounded-xl border border-border-strong bg-surface px-3 py-2.5 text-[13.5px] font-medium text-ink-primary shadow-[var(--shadow-float)] transition-all hover:border-accent/60"
        >
          <span className="flex items-center gap-2">
            <Plus size={15} className="text-accent transition-transform group-hover:rotate-90" />
            New question
          </span>
        </Link>
      </div>

      <nav className="mt-4 flex flex-col gap-0.5 px-3">
        <NavLink href="/" active={onAsk} icon={MessageSquareText}>
          Ask
        </NavLink>
        <NavLink href="/dashboards" active={pathname.startsWith("/dashboards")} icon={LayoutGrid}>
          Dashboards
        </NavLink>
      </nav>

      <div className="mx-3 mt-5 flex items-center gap-2 rounded-lg border border-border bg-surface/60 px-2.5 py-1.5 focus-within:border-accent/50">
        <Search size={13} className="text-ink-muted" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter chats"
          aria-label="Filter chats"
          className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink-primary outline-none placeholder:text-ink-muted"
        />
        {query && (
          <button aria-label="Clear filter" onClick={() => setQuery("")} className="cursor-pointer text-ink-muted hover:text-ink-primary">
            <X size={12} />
          </button>
        )}
      </div>

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {error && <p className="px-3 py-2 text-xs text-ink-muted">Couldn&apos;t reach the API for chat history.</p>}
        {chats && chats.length === 0 && (
          <p className="px-3 py-2 text-xs leading-relaxed text-ink-muted">
            Your conversations are saved here. Ask something to start one.
          </p>
        )}
        {pinned.length > 0 && (
          <section className="mb-3">
            <h3 className="kicker px-3 pt-2 pb-1.5">Pinned</h3>
            {pinned.map((c) => (
              <ChatRow key={c.id} chat={c} active={c.id === activeChatId} onNavigate={onNavigate} />
            ))}
          </section>
        )}
        {recent.length > 0 && (
          <section>
            <h3 className="kicker px-3 pt-2 pb-1.5">Recent</h3>
            {recent.map((c) => (
              <ChatRow key={c.id} chat={c} active={c.id === activeChatId} onNavigate={onNavigate} />
            ))}
          </section>
        )}
        {query && filtered.length === 0 && chats && chats.length > 0 && (
          <p className="px-3 py-2 text-xs text-ink-muted">No chats match “{query}”.</p>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-border px-4 py-3">
        <span className="text-[11px] leading-tight text-ink-muted">
          Simulated data
          <br />
          Northbeam is a demo company
        </span>
        <ThemeToggle />
      </div>
    </aside>
  );
}
