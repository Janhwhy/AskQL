"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

type Theme = "light" | "dark" | null; // null = follow system

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(null);
  // Real bug, reported with a hydration-mismatch error: `isDark` used to
  // read `window.matchMedia` directly during render. On the server
  // `window` doesn't exist (isDark -> false, renders Moon); on the
  // client's FIRST render — which React must reconcile against that
  // server HTML before any effect runs — `window` already exists, so if
  // the OS is in dark mode isDark -> true and it renders Sun instead,
  // mismatching the just-hydrated server markup. `mounted` keeps the icon
  // deterministic (always the server's Moon) through hydration, then
  // flips to the real system/stored preference in an effect — a normal
  // post-hydration state update, not part of the hydration diff.
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // The standard SSR-hydration-safety "mounted" flag (same pattern
    // next-themes uses) — flipping it is what lets isDark differ from the
    // server's value AFTER hydration completes, on purpose.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  useEffect(() => {
    // Reading localStorage (unavailable during SSR) is exactly the
    // "synchronize from an external system on mount" case the lint rule's
    // own docs carve out — a lazy useState initializer would crash SSR by
    // touching localStorage on the server, and useSyncExternalStore's
    // subscribe model doesn't fit a same-tab update (the `storage` event
    // only fires in *other* tabs).
    let stored: string | null = null;
    try {
      stored = localStorage.getItem("askql-theme");
    } catch {
      // private browsing / blocked storage — fall through to system default
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see comment above
    if (stored === "light" || stored === "dark") setTheme(stored);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (theme) {
      root.setAttribute("data-theme", theme);
      try {
        localStorage.setItem("askql-theme", theme);
      } catch {
        // ignore — theme still applies for this session
      }
    } else {
      root.removeAttribute("data-theme");
    }
  }, [theme]);

  const isDark =
    mounted &&
    (theme === "dark" ||
      (theme === null && window.matchMedia?.("(prefers-color-scheme: dark)").matches));

  return (
    <button
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label="Toggle theme"
      className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-raised hover:text-ink-primary"
    >
      {isDark ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}
