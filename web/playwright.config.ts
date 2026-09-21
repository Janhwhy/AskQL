import { defineConfig, devices } from "@playwright/test";

// Real bug, admitted here as the reason this file exists: every bug found
// in the Phase 7 dashboard work (a ResizeObserver feedback loop that
// silently killed chart animations, a percentage-height chain broken by a
// plain wrapper div, "table of X" rendering as a bar chart, tiles only
// draggable from a 20px title sliver) was caught by a human clicking
// around in a live browser -- never by anything that runs automatically.
// `agent/eval.py` covers the agent's SQL/chart-TYPE-decision logic against
// the real LLM; it has no way to catch a chart that decided correctly but
// renders empty, or a drag interaction that silently does nothing. This
// suite is the frontend counterpart: real assertions against real DOM
// state in a real browser, not a screenshot a human has to eyeball.
//
// Requires both dev servers already running (this project's existing
// workflow, see CLAUDE.md): `uvicorn api.main:app --port 8000` and
// `next dev` on :3000. Not auto-started here -- the backend needs a real
// LLM call chain (Gemini/Ollama fallback, DuckDB) that's out of scope for
// a test runner to bootstrap reliably.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // each test drives one shared dev backend/DB
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      // Bigger than the device default (1280x720) -- a dashboard tile can
      // easily extend past 720px, and a mouse coordinate outside the
      // viewport hits nothing (document.elementFromPoint returns null
      // there), which silently makes a drag never start. Caught exactly
      // that way: the first version of the drag test failed not because
      // dragging was broken, but because its start point was off-screen.
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1200 } },
    },
  ],
  timeout: 60_000, // LLM calls through the Ollama fallback are slow
});
