/** The Northbeam mark: a horizon arc with a beam rising through it toward
 * north. Drawn, not an icon-font glyph, so it carries the beam gradient. */
export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="askql-beam" x1="0" y1="1" x2="0.4" y2="0">
          <stop offset="0" stopColor="var(--beam-to)" />
          <stop offset="1" stopColor="var(--beam-from)" />
        </linearGradient>
      </defs>
      <rect x="0.5" y="0.5" width="31" height="31" rx="9" fill="var(--surface-raised)" stroke="var(--border-strong)" />
      <path d="M6 23.5a10 10 0 0 1 20 0" fill="none" stroke="var(--ink-muted)" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M9.5 23.5a6.5 6.5 0 0 1 13 0" fill="none" stroke="var(--border-strong)" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M16 25.5 L19.5 6" stroke="url(#askql-beam)" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="19.6" cy="6" r="1.8" fill="var(--beam-from)" />
    </svg>
  );
}
