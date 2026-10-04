"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { deleteChat, listChats, updateChat } from "@/lib/chatApi";
import type { ChatSummary } from "@/lib/types";

interface ChatsContextValue {
  chats: ChatSummary[] | null;
  error: boolean;
  refresh: () => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  togglePin: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** True while any agent answer is streaming — drives the beam's scan. */
  busy: boolean;
  setBusy: (busy: boolean) => void;
}

const ChatsContext = createContext<ChatsContextValue | null>(null);

/** Shared by the sidebar (lists/renames/pins/deletes chats) and ChatShell
 * (asks it to refresh after a turn lands). Optimistic updates everywhere, with
 * a refetch on failure as the source of truth. */
export function ChatsProvider({ children }: { children: ReactNode }) {
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setChats(await listChats());
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    // Initial fetch from an external system on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const rename = useCallback(
    async (id: string, title: string) => {
      setChats((prev) => prev?.map((c) => (c.id === id ? { ...c, title } : c)) ?? prev);
      try {
        await updateChat(id, { title });
      } catch {
        void refresh();
      }
    },
    [refresh]
  );

  const togglePin = useCallback(
    async (id: string) => {
      const target = chats?.find((c) => c.id === id);
      if (!target) return;
      setChats((prev) => prev?.map((c) => (c.id === id ? { ...c, pinned: !c.pinned } : c)) ?? prev);
      try {
        await updateChat(id, { pinned: !target.pinned });
      } finally {
        void refresh(); // server owns the ordering (pinned first, then recent)
      }
    },
    [chats, refresh]
  );

  const remove = useCallback(
    async (id: string) => {
      setChats((prev) => prev?.filter((c) => c.id !== id) ?? prev);
      try {
        await deleteChat(id);
      } catch {
        void refresh();
      }
    },
    [refresh]
  );

  const value = useMemo(
    () => ({ chats, error, refresh, rename, togglePin, remove, busy, setBusy }),
    [chats, error, refresh, rename, togglePin, remove, busy]
  );
  return <ChatsContext.Provider value={value}>{children}</ChatsContext.Provider>;
}

export function useChats() {
  const ctx = useContext(ChatsContext);
  if (!ctx) throw new Error("useChats must be used inside <ChatsProvider>");
  return ctx;
}
