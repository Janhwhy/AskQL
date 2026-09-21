export function StageIndicator({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-1 text-sm text-ink-muted">
      <span className="flex gap-0.5">
        <span className="animate-pulse-dot h-1.5 w-1.5 rounded-full bg-accent [animation-delay:-0.3s]" />
        <span className="animate-pulse-dot h-1.5 w-1.5 rounded-full bg-accent [animation-delay:-0.15s]" />
        <span className="animate-pulse-dot h-1.5 w-1.5 rounded-full bg-accent" />
      </span>
      <span>{label}</span>
    </div>
  );
}
