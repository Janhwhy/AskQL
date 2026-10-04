"use client";

import { Menu } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { BrandMark } from "./BrandMark";
import { ChatsProvider, useChats } from "./ChatsProvider";
import { Sidebar } from "./Sidebar";

function Canvas({ children }: { children: ReactNode }) {
  const { busy } = useChats();
  return (
    <main className="observatory-canvas grain relative isolate flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="beam-rail z-20" data-busy={busy} aria-hidden="true" />
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">{children}</div>
    </main>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [drawer, setDrawer] = useState(false);

  return (
    <ChatsProvider>
      <div className="flex h-full">
        {/* ONE sidebar: persistent on desktop, a slide-over drawer on mobile
            (rendering two copies duplicated every landmark and chat row). */}
        <div
          className={cn(
            "fixed inset-0 z-40 bg-black/40 backdrop-blur-sm transition-opacity md:hidden",
            drawer ? "opacity-100" : "pointer-events-none opacity-0"
          )}
          onClick={() => setDrawer(false)}
        />
        <div
          className={cn(
            "fixed inset-y-0 left-0 z-50 flex transition-transform duration-300 md:static md:translate-x-0",
            drawer ? "translate-x-0" : "max-md:invisible -translate-x-full"
          )}
        >
          <Sidebar onNavigate={() => setDrawer(false)} />
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-3 border-b border-border px-4 py-2.5 md:hidden">
            <button
              aria-label="Open menu"
              onClick={() => setDrawer(true)}
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-ink-secondary hover:bg-surface-raised"
            >
              <Menu size={18} />
            </button>
            <BrandMark size={22} />
            <span className="font-display text-[17px]">AskQL</span>
          </div>
          <Canvas>{children}</Canvas>
        </div>
      </div>
    </ChatsProvider>
  );
}
