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
      <ThemeToggle />
    </header>
  );
}
