# AskQL — Codex Handover

**Read this first. It is the operating context for this repo.**

AskQL is an agentic business-analytics chatbot. A user asks a business question in plain
English; the system generates SQL against a governed metric layer, runs it, picks a chart
type, renders it, and narrates a one-line insight.

Tagline: *governed answers, in plain English.*

Full design rationale lives in `docs/askql-project-spec.md`. This file is the working brief — what to
build, in what order, and the constraints that must not be violated.

---

## Non-negotiable constraints

These are design decisions already made. Do not change them without asking.

1. **Single process.** DuckDB permits one writer OR many readers, never both across
   processes. Data generation (`ingestion/run_daily_poll.py`, via Windows Task
   Scheduler — not an in-process APScheduler) and the FastAPI app never write
   concurrently. Do not spawn a separate ingestion worker. Do not add Celery.

2. **The agent never sees raw schema.** It reads YAML metric definitions only. If a
   question doesn't map to a defined metric, the correct behaviour is to say so — never
   to improvise SQL against raw tables.

3. **All generated SQL passes `sqlglot` validation before execution.** `SELECT` only.
   Reject anything else. This is the primary guardrail, not a nice-to-have — DuckDB has
   no role-based permissions to fall back on.

4. **The LLM never generates images.** It outputs structured JSON
   (`{chart_type, x, y, series}`); Recharts renders it client-side.

5. **Metrics must be deterministic, never bare `random()`.** (Revised 2026-09-20:
   project moved from real external APIs to a fully simulated company. Every
   number comes from a seeded, reproducible formula — trend + weekday pattern +
   seeded noise — never unseeded randomness.)

6. **Latency budget: p95 under one second.** This is the product thesis. If a change
   pushes past it, flag it rather than absorbing it.

---

## Stack

| Layer | Choice |
|---|---|
| Storage | DuckDB (single file) + Parquet for raw archive |
| Data generation | Deterministic simulation (`ingestion/simulate.py`), daily via Task Scheduler |
| Semantic layer | YAML + Pydantic validation |
| Metric retrieval | DuckDB VSS extension |
| Agent | LangGraph |
| SQL validation | `sqlglot` |
| Backend | FastAPI, SSE for streaming |
| Frontend | Next.js + React, Recharts, Tailwind + shadcn/ui |
| Tracing | Langfuse |
| Deploy | Docker → Railway/Render (needs persistent volume), Vercel for frontend |

Deliberately **not** used, and why:
- Postgres / Databricks — latency and setup cost; DuckDB is enough at this scale
- SQLAlchemy / Alembic — no server DB, the `duckdb` Python API is sufficient
- Redis — single process, `functools.lru_cache` covers it
- Celery — see constraint 1

---

## Data model

**Revised 2026-09-20.** Originally polled real external APIs (GitHub/npm/PyPI/HN)
and relabeled their numbers as business metrics. Hit real limits: rate limits,
a platform-side block on GitHub's stargazers/subscribers endpoints, and only
one real "product." Real ingestion code parked in `ingestion/sources/` and
`ingestion/scheduler.py`, unused but not deleted.

Now runs on a **fully simulated company** — `ingestion/company.py` (static:
24 products/5 categories, regions, channels, plan tiers, reps) and
`ingestion/simulate.py` (daily generator). Nothing fetched from the internet.

### How a number gets made
```
expected_sales(product, day) =
    base_daily_sales
    * (1 + growth_rate) ** day_index      # slow compounding growth
    * weekday_factor(day)                  # B2B weekend dip
    * seeded_noise(product, day)           # ±15%, deterministic
    * seeded_anomaly(product, day)         # rare (2%) spike/dip day
```
Seeded per `(entity, product_id, day_index, row_index)` — regenerating from
scratch reproduces identical history. Support tickets scale with a product's
own actual buyers (joined via `sales`), not the whole company's customer list.

### Tables
| Table | Grows | Holds |
|---|---|---|
| `products` | frozen | 24 rows: name, category, price, growth rate |
| `sales_reps` | frozen | 12 rows: name, region |
| `customers` | daily | signups, region, plan tier, `churned_at` |
| `sales` | daily | date, product, customer, channel, amount |
| `support_tickets` | daily | opened/closed, scoped per product's buyers |

Fact tables never duplicate region/channel onto the row — always joined
through `customers` at query time.

---

## Semantic layer format

`metrics/*.yaml`:

```yaml
metrics:
  new_customers:
    description: "New customer signups"
    source: customers
    filter: "signed_up_at = {grain}"
    aggregation: count
    grain: day

  revenue:
    description: "Total sales revenue"
    source: sales
    join: "sales JOIN customers ON customers.customer_id = sales.customer_id"
    expression: "SUM(sales.amount)"
    group_by: ["customers.region", "products.category"]
    grain: day
```

Validate with Pydantic on load. Fail loudly on a malformed definition rather than
silently skipping it.

Target 8–12 metrics covering: usage, acquisition, support load, eng velocity, marketing,
revenue, margin.

---

## Agent graph

```
question
  → router            classify intent: trend / comparison / single-metric / explanation
  → metric retrieval  VSS over metric definitions, return top-k relevant
  → ambiguity check   if 2+ metrics plausibly match, ASK instead of guessing
  → SQL generation
  → sqlglot validate  SELECT-only, reject otherwise
  → execute
  → self-correct      on error, feed error back, retry ONCE, then give up honestly
  → chart decision    output {chart_type, x, y, series} from result shape
  → narration         one sentence of insight
```

**The ambiguity node is the project's differentiator.** Most text-to-SQL systems guess
when a question is vague. This one asks — *"by 'growth' do you mean downloads or
contributors?"* — and remembers the answer for the session. Build it properly.

Every response returns the SQL used and the metric definition applied. Trust mechanics
are a feature, not debug output.

---

## Build order

**Revised 2026-09-20.** Phase 0/1 used to be time-gated — real data had to
accumulate before later phases had anything to chart. That's gone: simulated
history is a deterministic function of day-number, so a full multi-year
backfill is one instant local computation, not a wait. Done.

### Phase 0/1 — prove the data path, then generate it (done)
`ingestion/company.py` defines the company (frozen). `ingestion/simulate.py`
generates one day at a time, deterministically. `run_backfill.py` loops it
from `company.FOUNDED` to yesterday. `run_daily_poll.py` runs it once for
today via a **Windows Task Scheduler** job (not an in-process APScheduler+
deploy — nothing consumes the API yet, so an always-on deploy would sit
idle). Idempotent: reruns skip days that already exist.

### Phase 2 — metrics (done)
`metrics/*.yaml` — 10 metrics across `finance.yaml`, `acquisition.yaml`,
`support.yaml`. `metrics/loader.py` validates with Pydantic, fails loudly on
a malformed definition. `tests/test_metrics.py` compiles every metric and
declared dimension against the live DuckDB schema. Numbers hand-verified
against each other (e.g. opened − resolved = backlog, exactly).

### Phase 3 — minimal agent (done)
`agent/graph.py` — one LangGraph node: question + metrics context → SQL (Gemini
primary, local Ollama automatic fallback — `agent/llm.py`) → `agent/validation.py`
(sqlglot SELECT-only) → execute on a read-only DuckDB connection → raw JSON.
`agent/cli.py` runs the required ten questions.

First run: 7/10 — 3 real failures (hallucinated filter/join, MySQL-only date
function, silently wrong "this month" math). Fixed via a stricter prompt, not
Phase 4's self-correction node (different mechanism, still not built). Rerun:
10/10 — 9 correct answers matching Phase 2's hand-verified numbers, plus 1
correctly-refused out-of-scope question.

### Phase 4 — full agent (done)
Full graph in `agent/graph.py`: `generate_sql → run_sql → (error, retries==0) →
correct_sql → run_sql`, success path `→ decide_chart → narrate → END`. Chart
decision (`agent/chart.py`) is a pure deterministic function of result shape,
no LLM call. Ambiguity resolution persists per `thread_id` via LangGraph's
`MemorySaver`.

Three real bugs found and fixed via live testing (not just mocked tests):
chart y/series inversion on time+dimension results, `grain: day` misread as
"date filter required" (broke all-time totals), and the ambiguity
clarification round-trip being completely broken because the resolved
answer wasn't a declared `AgentState` field — LangGraph silently drops
`invoke()` input keys outside the schema. Fixed the field, and additionally
resolve the answer to a specific metric deterministically in code
(`_resolve_clarification`) rather than trusting the LLM to re-correlate its
own prior question — the local Ollama fallback reliably failed at that even
after the plumbing fix. Final run: 13/13 scenarios correct.

### Phase 5 — frontend (done)
`web/` — Next.js (App Router) + TypeScript + Tailwind v4 + Recharts. `/chat`
streams real SSE, one event per LangGraph node as it completes, not a
simulated typing effect. Fixed a real deadlock risk: the FastAPI app held a
write connection open app-wide while the agent opens its own read-only
connection per query — changed the app's own connection to `read_only=True`.

Dark-mode-first with a working light/dark toggle, palette reused from the
`dataviz` skill's validated reference instance. No `claude-in-chrome`
extension was connected, so visual verification used headless Playwright
instead of skipping it — caught a redundant KPI caption, a currency-format
heuristic that would have mislabeled day-counts and fractions as dollars,
and a Recharts `dataKey` bug (a raw SQL alias containing a dot gets
path-parsed as a string dataKey, silently breaking the line chart — fixed
with function accessors).

Two more real bugs found after initial ship (from a user screenshot and a
reported error, not further self-review): a hydration mismatch in
`ThemeToggle` (`isDark` read `window.matchMedia` synchronously during
render, differing between server and client's first paint — fixed with the
standard `mounted`-flag pattern), and `decide_chart`'s bar branch breaking
on two categorical columns + one metric (e.g. "best selling products and
their category" — put a category STRING on the numeric y-axis, no bars
could render). Fixed by splitting columns by actual type, plus a second fix
in the frontend's grouped-bar logic, which wrongly assumed a series value
always repeats across x — false for a 1:1 mapping like "each product has
exactly one category." Now detects real repetition vs. 1:1 and renders
per-row colored bars with a proper legend for the 1:1 case.

Three more real bugs, same session: (1) chart type never read the question
— "pie chart for revenue by region" returned a bar chart, since chart
selection is deliberately shape-only (constraint 4) and had no pie type at
all. Fixed `decide_chart` to check for an explicit request in the question
text first, added real pie support (`PieChartView`, capped at 8 slices,
falls back to bar past that). (2) The SSE stream had no exception
handling — any unhandled failure (confirmed live: Gemini rate-limited +
Ollama fallback also down) killed the connection mid-stream with no
terminal event, hanging the UI forever. Fixed with a try/except yielding a
proper error event (raw exception stays server-side in the log, user gets
a plain message), plus a client-side 45s idle timeout as a second layer
against a genuine network stall with no exception to catch. (3) Long
category names clipped in rotated bar labels — took three wrong theories
(SVG margin, an ancestor's `overflow-x`, the container's total height)
before measuring the ACTUAL DOM bounding boxes showed Recharts reserves
the rotated-label band as a fixed size independent of container height;
fixed by raising that specific `XAxis` `height` prop plus truncating
labels over 18 characters (full name stays in the tooltip).

One more, caught live: narration hallucinated a "highest" claim on a
24-row result ($602K claimed highest, real highest was $2.69M, not
close) — root cause was asking the LLM to eyeball a max across a JSON
blob, the same "don't delegate a deterministic computation to LLM
judgment" mistake as the earlier chart bugs. Fixed with
`_compute_extremes()` computing the true top/bottom over the FULL result
set and handing it to the prompt as a verified fact. Verifying immediately
found a second hallucination on top of the fix (an unverified "second
place" claim — the named product was actually 9th of 24); tightened the
prompt to forbid ranking anything beyond the pre-computed facts. Confirmed
stable across 3 repeated live runs.

**Chart-type follow-ups** ("now give it as a table" after "pie chart for
top 5 products by sales") reuse the prior turn's SQL/rows instead of
re-querying — `_is_chart_followup()` matches a message that's ONLY a
chart-type request via a narrow anchored regex; anything with real extra
content falls through to a fresh question, so an unrecognized phrasing
just costs a normal query, never a wrong answer. Pulls the checkpointed
prior turn (same `thread_id` mechanism the ambiguity node uses), re-runs
`decide_chart` on the SAME rows, reuses the narration — no new LLM call,
no new DB query, no risk of the regenerated SQL drifting from the
original result. State is never mutated by this path, so a second
follow-up still reuses the ORIGINAL data. Verified live in the browser
and unit-tested; caught a real regex gap along the way ("now pie again"
initially didn't match, "again" was missing from the trailing-word list).

**Continuation questions** ("now the same for 7 days" after "daily revenue
for the last 14 days") threw `Binder Error: column "units_sold" not
found` — not a chart-followup phrasing, so it fell through to a cold
fresh question with no memory of the prior turn, and the LLM drifted to
an unrelated metric. Two fixes: (1) `prior_question`/`prior_sql` added to
`AgentState` (must be declared or LangGraph silently drops them, same
lesson as `clarification_answer`) plus `_recent_context_block()` injecting
the previous question + SQL into the prompt with instructions to keep the
same metric/shape on a continuation, ignore it otherwise; (2) tightened
the prompt to state a metric's *name* is never a real column, only its
`expression` field is — the LLM had confused `units_sold` (a metric name)
with an actual column. Also fixed a hardcoded `clarifications: {}` reset
on every fresh question found in the same code path, which broke the
"remembered for the session" claim above. Verified live via curl (only
the `INTERVAL` changed between turns, metric stayed on `sales.amount`) and
a Playwright screenshot; unit-tested
(`test_continuation_question_gets_prior_turn_as_context`). 43/43 tests
pass.

### Phase 6 — polish

**Golden eval harness** (`agent/eval.py`, out of order — before the rest
of this phase). Every bug above was caught by a human eyeballing a live
screenshot after it shipped; the mocked pytest suite only proves the
LangGraph wiring, never that the LLM writes correct SQL for real English
questions. `agent/eval.py` runs ~20 realistic scenarios (basic metrics,
date math, both ambiguity cases, the out-of-scope refusal, explicit chart
requests, the metric-name-vs-`expression` trap, the continuation and
chart-followup cases) against the REAL `ask()` — real LLM, real DB — with
structural assertions (SQL must/must-not contain X, correct chart type,
correct refusal/ambiguity). `python -m agent.eval`, exits 1 on any
failure. First run: 19/20 passed; the one failure was the eval's own
assertion being too strict (demanded a column literal that correctly
doesn't appear when no date range was asked), not an agent bug — fixed
the assertion, re-verified. Ran entirely on the Ollama fallback (Gemini's
daily quota was already exhausted) — confirmed the fallback holds up
under real load.

Langfuse tracing, caching, proactive anomaly detection, README — still open.

### Phase 7 — dashboards (done)

User-requested: pin charts from chat into persistent, arrangeable
dashboards (PowerBI/Tableau-style), not just one-off chat answers.
Layout/metadata lives in a **separate SQLite file**
(`data/dashboards.sqlite3`, `api/dashboards_db.py`) — deliberately NOT a
table in `data/askql.db`, so pinning/rearranging never needs a write
connection to the single-writer DuckDB file (constraint 1). A pinned item
stores only `question`/`sql`/chart-shape/`narration`, never a data
snapshot — `GET /dashboards/{id}` (`api/dashboards.py`) re-runs each
item's stored SQL live on every load, re-validated through
`validate_select_only` every time (constraint 3 applies to stored SQL
again, not just freshly-generated SQL). Frontend: `PinButton` on chat
answers, `/dashboards` list, `/dashboards/[id]` grid
(`react-grid-layout`) with drag/resize/remove, layout persisted via
`PUT .../layout`.

Two real bugs found live: (1) a custom `ResizeObserver` measuring a tile's
content div and feeding that height back into the chart rendered INSIDE
it created a feedback loop that corrupted Recharts' draw-in animation —
valid SVG paths, real colors, `opacity:1`, but nothing visually drew;
fixed by deleting the custom observer and passing Recharts'
`ResponsiveContainer` a CSS `height="100%"` instead, letting it own its
own resize-observation. (2) that fix surfaced a second bug: percentage
height only resolves through ancestors with a DEFINITE height, and the
pie/1:1-bar chart's legend wrapper was a plain `<div>` (height:auto) —
confirmed via measurement that Recharts' container ended up with a
literal `height: 0`. Fixed by making those wrappers `flex h-full
flex-col` with the chart in a `min-h-0 flex-1` child; also disabled
`isAnimationActive` everywhere since the draw-in animation has no reason
to survive a container resizing right after mount. Verified: backend
round-tripped via `TestClient` (including rejecting an unsafe `DELETE`
pin attempt with 400); frontend verified live end-to-end in the browser
(pinned two real charts, confirmed both fully render — not just axes —
dragged to rearrange, confirmed layout survives a reload). `tsc`/`eslint`
clean, all 43 pytest tests still pass.

**Two more real bugs, reported live right after shipping:** (1) "table of
top 10 products" got a bar chart — `decide_chart`'s table regex only
matched fixed phrases ("as a table", "table view") and never the bare
word "table" itself, unlike every other chart type's pattern. Fixed to
match bare `table` too; regression test added, 44/44 pass. (2) dashboard
tiles were only draggable from a ~20px title strip — the chart body
carried `no-drag` (added for an unrelated reason alongside the
ResizeObserver fix above), so dragging from the chart itself, the natural
first attempt, silently did nothing. Fixed by making the whole tile a
drag surface and scoping `no-drag` down to just the remove button; wheel-
scroll inside a table tile is unaffected since it doesn't trigger
`react-draggable`'s mousedown-based drag. Verified live: dragged a tile
by its table body (not the header), confirmed it moved and the position
survived a reload.

**Added real frontend test coverage** (`web/e2e/dashboard.spec.ts`,
`@playwright/test`, `npm run test:e2e` — requires both dev servers
running) since every bug above was only ever caught by a human clicking
around, never by anything automatic (`agent/eval.py` only covers the
agent's SQL/chart-type logic, not frontend rendering/interaction). Two
tests: "table of X" renders an actual `<table>`; a pinned chart's SVG has
both a non-trivial `d` AND a non-trivial rendered width (checking `d`
alone wouldn't have caught the ResizeObserver bug), then a drag from a
point INSIDE the tile's body (not its header) changes and persists the
position. First run of the drag test failed for a reason worth recording:
the default Playwright viewport (1280x720) was smaller than the tile
being dragged, so the drag's start coordinate was below the fold and hit
nothing (`document.elementFromPoint` returned `null` there) — confirmed
via a throwaway debug script that the identical drag worked fine with a
bigger viewport. Fixed the TEST (viewport size +
`scrollIntoViewIfNeeded()`), not the app. Both tests pass now.

---

## Repo layout (suggested)

```
askql/
├── AGENTS.md
├── docs/askql-project-spec.md
├── metrics/              # YAML metric definitions
├── ingestion/
│   ├── sources/          # one module per API
│   ├── derive.py         # derived metrics
│   └── scheduler.py
├── agent/
│   ├── graph.py          # LangGraph definition
│   ├── nodes/
│   └── validation.py     # sqlglot guardrails
├── api/
│   └── main.py           # FastAPI + lifespan scheduler
├── data/
│   ├── askql.db
│   └── raw/              # Parquet archive
└── web/                  # Next.js
```

---

## Conventions

- Python 3.11+, type hints throughout, Pydantic for any structured data
- `ruff` for lint and format
- Secrets in `.env`, never committed. `.env.example` stays current
- `data/askql.db` is gitignored; ship a seed script instead
- Tests for the validation layer and metric loading at minimum — the agent nodes are
  harder to test, but SQL validation must be covered

---

## Known tradeoffs (state these, don't hide them)

- **Single-writer DuckDB** caps us at one API instance. Scaling past that means moving to
  Postgres. Deliberate choice for latency.
- **No DB-level permissions.** `sqlglot` validation substitutes for a read-only role.
- **All company data is simulated.** Always labelled as such — a demo company
  (Northbeam), not a real business.
- **Text-to-SQL is a crowded category.** The differentiation is governance and ambiguity
  handling, not the chatbot itself.

---

## Open decisions

- [x] ~~Confirm `askql` is free on npm / GitHub / domain~~ — **not free.** `askql` is
      already taken on npm and as a GitHub org by an unrelated, existing project also
      called "AskQL" (a query language). Real collision, not a squatter — revisit the
      name before this ships anywhere public.
- [x] ~~Data source strategy~~ — **2026-09-20: pivoted from real GitHub/npm/PyPI
      polling to a fully simulated company** (`ingestion/company.py` +
      `ingestion/simulate.py`). Real ingestion code parked, not deleted, in
      `ingestion/sources/`.
- [ ] Real-data cleaning/dedup/ID-resolution layer — future scope, no real
      source to design against yet.
- [ ] Proactive anomaly alerts: v1 or v2
