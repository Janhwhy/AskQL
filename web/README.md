# AskQL — web

Phase 5's frontend: a chat interface over the Phase 3/4 agent
(`agent/graph.py`). Next.js (App Router) + TypeScript + Tailwind v4 +
Recharts.

## Running locally

Needs the FastAPI backend running first (from the repo root, not here):

```bash
uvicorn api.main:app --reload
```

Then, in this directory:

```bash
npm install
cp .env.local.example .env.local   # only if it's missing
npm run dev
```

Open http://localhost:3000. The backend must be on :8000 (or update
`NEXT_PUBLIC_API_URL` in `.env.local`).

## How it talks to the agent

`POST /chat` on the FastAPI backend streams Server-Sent Events — one real
event per LangGraph node as it completes (`agent/graph.py`'s `ask_stream()`),
not a simulated typing effect. `lib/api.ts` parses the stream by hand since
native `EventSource` can't send a POST body; `lib/types.ts` mirrors the
event shapes and must be kept in sync with `agent/graph.py` and
`api/main.py` by hand — there's no shared schema generation here.

## Design system

`app/globals.css` defines the palette as CSS custom properties, dark-mode-first
with a working light/dark toggle (`components/ThemeToggle.tsx`, persisted to
`localStorage`). The categorical/status colors are reused verbatim from the
`dataviz` skill's validated reference palette (CVD-safe, contrast-checked) so
the site's own chrome and its embedded Recharts charts share one coherent
set of roles instead of two competing palettes.

## Visual verification

No `claude-in-chrome` extension was connected when this was built, so
`test-visual.mjs` and `test-ambiguity.mjs` (Playwright, headless) stand in
for it — screenshot the empty state, a KPI answer, a line chart, the theme
toggle, and the full ambiguity-clarification round trip. Not a formal test
suite, just what caught two real bugs during the build (a redundant KPI
caption, and Recharts' `dataKey` string-path-parsing silently breaking on a
raw SQL alias containing a dot). Run with `node test-visual.mjs` (backend +
`next dev` must both be running); screenshots land in `screenshots/`
(gitignored).
