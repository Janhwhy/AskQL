import { LayoutGrid, MessageSquare } from "lucide-react";
import Link from "next/link";
import { ThemeToggle } from "./ThemeToggle";

export function Header() {
  return (
    <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3 sm:px-8">
      <div className="flex items-baseline gap-2.5">
        <span className="text-[15px] font-semibold tracking-tight text-ink-primary">
          AskQL
        </span>
        <span className="hidden text-[13px] text-ink-muted sm:inline">
          governed answers, in plain English
        </span>
      </div>
      <nav className="flex items-center gap-1">
        <Link
          href="/"
          className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm text-ink-secondary transition-colors hover:bg-surface-raised hover:text-ink-primary"
        >
          <MessageSquare size={14} />
          <span className="hidden sm:inline">Chat</span>
        </Link>
        <Link
          href="/dashboards"
          className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm text-ink-secondary transition-colors hover:bg-surface-raised hover:text-ink-primary"
        >
          <LayoutGrid size={14} />
          <span className="hidden sm:inline">Dashboards</span>
        </Link>
        <div className="ml-1.5">
          <ThemeToggle />
        </div>
      </nav>
    </header>
  );
}
