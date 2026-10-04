# Phase 8 — persistent chats, UI revamp, customizable dashboards

Implementation plan, written 2026-10-04 before any code. Four workstreams, built
in this order (each one leaves the app working):

---

## 1. Chat memory — saved, renamable, pinnable, deletable chats

### Where the gaps are today
- `ChatShell` keeps turns in React state and makes a fresh `thread_id` on every
  page load, so a refresh loses the whole conversation.
- The agent's conversational context (prior question/SQL, resolved
  clarifications, last result for chart-type follow-ups) lives in LangGraph's
  in-memory `MemorySaver`. Restart the API and every thread forgets it. Even
  once chats are saved, reopening an old one wouldn't bring that context back.

### Backend
- **`api/chats_db.py`**: a stdlib-`sqlite3` store in a new file,
  `data/chats.sqlite3`. It follows `dashboards_db.py` exactly and is kept out
  of DuckDB for the same constraint-1 reason.
  - `chats(id, title, pinned, created_at, updated_at)`
  - `chat_turns(id, chat_id, seq, question, status, sql, columns_json,
    rows_json, chart_json, narration, clarification_json, error, created_at)`.
    This is a **snapshot** of what was answered at the time. It differs on
    purpose from dashboards, which re-run their SQL live: a chat transcript is
    a record. The stored rows are capped.
- **The server persists turns, not the client.** `/chat` wraps `ask_stream()`.
  When a terminal event arrives (`done` / `error` / `clarification`) it writes
  the turn. A clarification answer updates that same turn in place instead of
  adding a new one. The chat id is the agent's `thread_id`. A chat row is
  created lazily on its first message, and its title is auto-set from the
  first question with no LLM call (latency budget).
- **`api/chats.py`** router: `GET /chats` (pinned first, then most recent),
  `GET /chats/{id}` (with turns), `PATCH /chats/{id}` (`title`, `pinned`),
  `DELETE /chats/{id}`.
- **Durable agent context**: swap `MemorySaver` for LangGraph's `SqliteSaver`
  (`data/checkpoints.sqlite3`, new dep `langgraph-checkpoint-sqlite`). This
  lets "now the same for 7 days" or "make it a table" work on a chat reopened
  days later, after a restart. Deleting a chat also deletes its checkpoint
  thread. Tests keep an in-memory saver through a `conftest.py` fixture, so
  test runs never leak state into each other.

### Frontend
- Routes: `/` = new chat, `/c/[id]` = an existing chat (turns hydrated from
  `GET /chats/{id}`). On the first message of a new chat the URL is replaced
  with `/c/{id}` without a remount.
- A sidebar with **Pinned** and **Recent** sections. Each row has an overflow
  menu with Rename (inline edit), Pin/Unpin and Delete (with an inline
  confirm). It also has a "New chat" button and a quick filter box.

### Answer to "is the context thing already implemented?"
Yes, within one session. A follow-up like "now the same for 7 days" keeps the
same metric and changes only the parameter. "Make it a table/pie/bar" reuses
the previous result without re-querying. Clarification answers are
remembered. It was lost on refresh or restart, and this phase fixes that.

---

## 2. UI revamp — design direction

**"Observatory"**: editorial and instrument-panel. The data is the subject,
like readings on a well-made scientific instrument.

| | |
|---|---|
| Display type | *Instrument Serif* for headlines and the big numbers, which gives an editorial voice |
| Body | Geist (already loaded) |
| Data / labels | Geist Mono, used for small-caps section labels, SQL and tabular figures |
| Color story | Warm near-black ink is the dominant tone. One accent, "beam" amber-orange (the brand's existing orange, pushed brighter). Warm paper neutrals in light mode. The validated dataviz series palette stays untouched for charts. |
| Anchor | **The beam**: a thin, luminous amber gradient line that runs along the top of the app, glows under the active nav item, and "scans" while the agent is working. It sits over a faint graph-paper dot grid with film grain. With the logo removed, the beam and grid still identify it. |
| Motion | One strong entrance per answer, which reveals stage by stage as SSE events arrive. Beam scanning while busy. Nothing decorative beyond that. |

Pieces: the app shell (sidebar and main canvas), a redesigned empty state
(serif hero plus suggestion cards), the answer card (mono section labels like
`ANSWER`, `QUERY`, `METRIC`, a stage timeline instead of dots), the input dock,
the dashboards gallery and the dashboard canvas.

---

## 3. Dashboards — Power BI-lite customization

### Backend (`dashboards_db.py` / `dashboards.py`)
- Additive migrations through `ALTER TABLE ... ADD COLUMN` when the column is
  missing. No data loss on the existing `dashboards.sqlite3`.
  - `dashboards.description`
  - `dashboard_items.kind` (`chart` | `text`) and `dashboard_items.config_json`
- **Tile config** (`config_json`): `title` (overrides the question), `color`
  (a palette slot 1–8, the start of the series rotation), `display_type`
  (override of `chart_type`: line / area / bar / horizontal bar / pie / donut
  / table / kpi), `show_narration`, `show_legend`.
- **Text tiles** (`kind = text`): free text with a light markdown subset
  (headings, bold, bullets). No SQL, so there's nothing to validate or run.
- New endpoints: `PATCH /dashboards/{id}` (name, description),
  `PATCH /dashboards/{id}/items/{item_id}` (config / text), `POST
  /dashboards/{id}/text` (add a text tile), `POST
  /dashboards/{id}/items/{item_id}/duplicate`.
- Constraint 3 is unchanged: chart items still go through
  `validate_select_only` on pin and on every re-run.

### Frontend
- **Edit / View mode toggle**. View is a clean presentation surface with no
  drag handles. Edit enables drag and resize and shows each tile's toolbar.
- **Tile inspector**: a side panel that opens from a tile. It holds the title,
  a color swatch picker, a display-type picker (options gated by result shape,
  e.g. KPI only for a 1-row result, pie only for ≤ 8 slices), and the
  legend/narration toggles. The tile updates live as you change them.
- **Text tile** editing happens in place.
- Inline rename of the dashboard name and description. Duplicate and remove a
  tile.
- **"Ask to add" bar** on the dashboard. Type a question, and it runs the
  agent and drops the answer onto the canvas as a new tile, without a detour
  through chat.

Deliberately out of scope this phase: a global cross-tile filter (a date
range applied to every tile), which needs SQL rewriting across arbitrary
metrics, and PNG/PDF export.

---

## 4. Verification
- `pytest`: the chats store and API (create via `/chat`, list order with
  pins, rename, delete), the dashboard migration, config PATCH, text tiles,
  duplicate, and that text tiles skip SQL validation without opening a hole.
- `web/e2e/*.spec.ts` (per CLAUDE.md conventions):
  - chats persist across reload, rename, pin and delete;
  - tile customization (title, color, display type) persists;
  - a text tile can be added and edited.
  Existing specs are updated for any changed selectors.
- `tsc --noEmit`, `eslint`, `ruff`, plus live Playwright screenshots of every
  screen in both themes.
- CLAUDE.md gets a Phase 8 section.
