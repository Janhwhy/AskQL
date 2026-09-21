# AskQL — Claude Code Handover

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
   Scheduler — not an in-process APScheduler, see "Build order") and the FastAPI
   app never write concurrently. Do not spawn a separate ingestion worker. Do
   not add Celery.

2. **The agent never sees raw schema.** It reads YAML metric definitions only. If a
   question doesn't map to a defined metric, the correct behaviour is to say so — never
   to improvise SQL against raw tables.

3. **All generated SQL passes `sqlglot` validation before execution.** `SELECT` only.
   Reject anything else. This is the primary guardrail, not a nice-to-have — DuckDB has
   no role-based permissions to fall back on.

4. **The LLM never generates images.** It outputs structured JSON
   (`{chart_type, x, y, series}`); Recharts renders it client-side.

5. **Metrics must be deterministic, never bare `random()`.** (Revised
   2026-09-20 — see "Data model" below: the project moved from real external
   APIs to a fully simulated company, so "derive from real data" no longer
   applies literally. The spirit survives: every number must come from a
   seeded, reproducible formula — trend + weekday pattern + seeded noise —
   never unseeded randomness, so charts and anomalies mean something and
   regenerating history from scratch reproduces it exactly.)

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

**Revised 2026-09-20.** Originally this project polled real external APIs
(GitHub/npm/PyPI/HN) and relabeled their numbers as business metrics. That
hit real limits: rate limits, a platform-side block on GitHub's
stargazers/subscribers endpoints (confirmed account-independent, not
fixable), and — the real problem — exactly one real "product" to point at,
when the actual goal is a rich multi-product company for a chatbot to query.
Real ingestion code is parked in `ingestion/sources/` (GitHub/npm/PyPI/HN
modules) and `ingestion/scheduler.py`, unused but not deleted.

The project now runs on a **fully simulated company** — see
`ingestion/company.py` (static definition: 24 products across 5 categories,
regions, channels, plan tiers, sales reps) and `ingestion/simulate.py` (the
daily generator). Nothing is fetched from the internet anymore.

### How a number gets made
Every fact (a sale, a support ticket, a new customer, a churn) comes from a
seeded, deterministic formula — never bare `random()`:

```
expected_sales(product, day) =
    base_daily_sales
    * (1 + growth_rate) ** day_index      # slow compounding growth
    * weekday_factor(day)                  # B2B weekend dip
    * seeded_noise(product, day)           # ±15%, deterministic per (product, day)
    * seeded_anomaly(product, day)         # rare (2%) spike/dip day
```

Seeding is per `(entity, product_id, day_index, row_index)`, via Python's
`random.Random(str)` — deterministic across runs. Regenerating the full
history from scratch reproduces it exactly. Support tickets scale with a
product's own actual buyer count (via a `sales` join), not the whole
company's customer list — an earlier version got this wrong and inflated
ticket volume ~24x by scaling against every customer for every product.

### Fact vs. dimension tables
Fact tables (`sales`, `support_tickets`) never duplicate region/channel onto
the row — always joined through `customers` at query time, the same lookup
a human analyst would do, just live instead of a weekly manual pivot.

| Table | What it is |
|---|---|
| `products` | 24 rows, frozen: name, category, price, growth rate |
| `sales_reps` | 12 rows, frozen: name, region |
| `customers` | grows daily via simulated signups; has `churned_at` for churn |
| `sales` | grows daily: date, product, customer, channel, quantity, amount |
| `support_tickets` | grows daily: date, product, customer, opened/closed, status |

### What's still an open modeling assumption
Region/channel splits, tier-value weights, ticket rates per category — all
hand-set constants in `ingestion/company.py`, documented inline same as
`RATE_PER_DOWNLOAD` used to be. Tunable, not measured.

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

Target 8–12 metrics covering: revenue (by product/category/region/channel), new
customers, churn, support ticket volume/resolution, average deal size.

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
accumulate before later phases had anything to chart, which meant waiting
days/weeks. That constraint is gone: simulated history is a deterministic
function of day-number, so a full multi-year backfill is one instant local
computation (`python -m ingestion.run_backfill`, ~4 min for ~20 months ×
24 products), not a waiting game. Both phases below are done.

### Phase 0/1 — prove the data path, then generate it (done)
`ingestion/company.py` defines the company (frozen). `ingestion/simulate.py`
generates one day at a time, deterministically. `run_backfill.py` calls it
in a loop from `company.FOUNDED` to yesterday. `run_daily_poll.py` calls it
once for today, via a **Windows Task Scheduler** job (not an in-process
APScheduler+deploy — see below) — fires daily, generates today's sales/
tickets/signups/churn, backs up the DB, exits. Idempotent: reruns skip
whatever day already exists.

Why Task Scheduler over the originally-planned always-on FastAPI+APScheduler
deployment: nothing consumes the API yet (no agent, no frontend), so an
always-on deploy would sit idle. Revisit deploying once Phase 5 needs
something to hit. `api/main.py` still exists (health/stats endpoints) but no
longer runs a scheduler in-process, to avoid two writers touching the same
DuckDB file.

### Phase 2 — metrics (done)
`metrics/*.yaml` — 10 metrics across `finance.yaml` (revenue, average_deal_size,
units_sold), `acquisition.yaml` (new_customers, churned_customers, active_customers),
`support.yaml` (support_tickets_opened/resolved, support_backlog,
avg_resolution_time_days). `metrics/loader.py` validates every definition with
Pydantic — fails loudly on a malformed one, never skips it. `tests/test_metrics.py`
compiles every metric's SQL (and every declared dimension) against the live
DuckDB schema, not a mock. Numbers hand-verified: e.g. `support_tickets_opened`
− `support_tickets_resolved` = `support_backlog` exactly; `avg_resolution_time_days`
≈ 1/(daily resolve chance) as designed.

### Phase 3 — minimal agent (done)
`agent/graph.py` — one LangGraph node: question + metrics context → SQL (Gemini
primary, local Ollama automatic fallback on any Gemini failure — `agent/llm.py`)
→ `agent/validation.py` (sqlglot SELECT-only, primary guardrail) → execute on a
**read-only** DuckDB connection → raw JSON. `agent/cli.py` runs the required ten
questions.

First run: 7/10 correct — 3 real failures (a hallucinated filter/join not in the
chosen metric, a MySQL-only date function DuckDB doesn't have, silently wrong
date math for "this month"). Fixed via a stricter prompt (explicit DuckDB date
syntax, explicit date-phrase definitions, worked examples) — not via Phase 4's
self-correction node, which is a different mechanism (retry after an execution
error) and deliberately still not built. Rerun: 10/10 — 9 correct answers
(cross-checked against Phase 2's hand-verified numbers, e.g. backlog=698,
churned=117) plus 1 correctly-refused out-of-scope question ("what's the
weather" → no metric answers this, said so instead of guessing).

### Phase 4 — full agent (done)
Full graph in `agent/graph.py`: `generate_sql → run_sql → (error, retries==0) →
correct_sql → run_sql`, success path `→ decide_chart → narrate → END`. Chart
decision (`agent/chart.py`) is a pure deterministic function of result shape —
no LLM call, per constraint 4. Ambiguity resolution persists across calls
sharing a `thread_id` via LangGraph's `MemorySaver`.

Audited and fixed three real bugs found while verifying this against a live
LLM, not just the mocked control-flow tests:
- **Chart y/series inversion** — for a time-series-plus-dimension result
  (e.g. "revenue by region over time"), `y` and `series` landed backwards
  (categorical column as `y`, numeric as `series`) because the line-chart
  branch picked by column position instead of type, unlike the bar-chart
  branch which already did this correctly. The test that should have caught
  it used a loose `set()` assertion that didn't check which field got which
  role. Fixed both the function and the test.
- **`grain: day` misread as "date filter required"** — asking for an
  all-time total ("how many customers have churned in total") got wrongly
  refused as unanswerable. Fixed via an explicit prompt rule + example: a
  `time_column` is available to filter on, never mandatory.
- **The ambiguity clarification round-trip was completely broken** — the
  resolved answer (`clarification_answer`) never reached any node because it
  wasn't declared as a field on the `AgentState` TypedDict, and LangGraph
  filters `invoke()` input against the graph's declared schema, silently
  dropping anything else. Fixed by declaring the field, **and** by resolving
  the answer to a specific metric deterministically in code
  (`_resolve_clarification`, keyword-overlap match) rather than trusting the
  LLM to re-correlate its own prior question from a prompt block — a 7B
  local model reliably failed at that even once the plumbing was fixed,
  same reasoning as making chart decision deterministic. Re-verified live,
  end to end, against the same model that originally failed.

Final live run: 13/13 scenarios behaved correctly (10 direct answers with
correct chart types and narration, 2 ambiguity round-trips that correctly
asked then correctly resolved, 1 correct out-of-scope refusal) — all cross-
checked against numbers hand-verified in earlier phases.

### Phase 5 — frontend (done)
`web/` — Next.js (App Router) + TypeScript + Tailwind v4 + Recharts.
`api/main.py`'s `/chat` endpoint streams real SSE, one event per LangGraph node
as it actually completes (`agent/graph.py`'s new `ask_stream()`), not a
simulated typing effect. Fixed a real deadlock risk found in review: the
FastAPI app previously held a **write** connection open for its whole
lifetime while the agent opens its own read-only one per query — DuckDB
doesn't allow a write + read-only connection on the same file at once, so
`/chat` would have failed the moment it was hit. Changed the app's own
connection to `read_only=True` (it never wrote anyway).

Design: dark-mode-first with a working light/dark toggle, palette reused
verbatim from the `dataviz` skill's validated reference instance (CVD-safe,
contrast-checked) so the UI chrome and embedded charts share one coherent
set of colors. Ambiguity clarification renders as clickable chips; ran the
full ask → clarify → resolve round trip live and it works.

No `claude-in-chrome` extension was connected during the build, so visual
verification used headless Playwright screenshots instead of skipping it.
That caught three real bugs no type-check would have: a redundant KPI
caption repeating the question already shown above it; a currency-format
heuristic that would have mislabeled `avg_resolution_time_days` (a day
count) and `churn_rate` (a fraction) as dollar amounts, fixed to format by
column-name keyword instead of by the number's shape; and a Recharts
`dataKey` bug — passing a raw SQL column alias like `"sum(sales.amount)"` as
a string `dataKey` gets path-parsed (it contains a dot), silently breaking
the line into disconnected trailing points on some queries. Fixed by
switching every `dataKey` to a function accessor, which does a direct
lookup and bypasses path parsing entirely.

**Two more real bugs found after initial ship**, from an actual user
screenshot and a reported error, not further self-review:
- **Hydration mismatch in `ThemeToggle`** — `isDark` read `window.matchMedia`
  synchronously during render whenever no theme was stored yet. The server
  (no `window`) always rendered the Moon icon; the client's first render
  (before any effect runs, but which React must reconcile against that
  server HTML) already has `window`, so on a system in dark mode it
  rendered Sun instead — a genuine server/client mismatch. Fixed with the
  standard `mounted` flag pattern (same one `next-themes` uses): icon stays
  at the server's deterministic value through hydration, flips to the real
  preference in an effect afterward, which is a normal post-hydration
  update, not part of the hydration diff.
- **`decide_chart`'s bar-chart branch broke on two categorical dimensions
  plus one metric** — e.g. "best selling products and their category"
  returns columns `[name, category, units_sold]`; both `name` and
  `category` are non-numeric. The old logic assumed "one categorical
  column, everything else numeric," so it put the `category` STRING on the
  numeric y-axis (no bars could render — Recharts can't map text to a bar
  height) and mis-used `units_sold` as a per-row "series," producing one
  legend swatch per row and no visible bars. Fixed `decide_chart` to split
  columns by actual type (numeric -> y, categorical -> x then series) —
  caught via a real screenshot, not proactive testing, then added a
  regression test with that exact column shape. Separately, rendering that
  correct decision uncovered a second issue: the frontend's grouped-bar
  logic assumed a series value repeats across x (e.g. region repeating per
  date) — wrong assumption for a 1:1 mapping like "each product has exactly
  one category," where it pivoted into mostly-empty per-category bars.
  Fixed by detecting whether x genuinely repeats; when it doesn't, render
  one bar per row colored by its category via Recharts `Cell`, with a
  proper small legend, instead of faking a grouped series.

**Chart type never read the question — "pie chart for revenue by region"
silently returned a bar chart.** Not a prompt-understanding failure: chart
type is (deliberately, per constraint 4) a pure function of the query
result SHAPE, and it had no pie chart type at all and never looked at the
question text, so an explicit request had no way to take effect. Fixed
`decide_chart` (`agent/chart.py`) to check for an explicit request
("pie chart", "as a table", "bar chart", etc. via regex) BEFORE falling
back to shape inference, and added real pie chart support end to end
(`PieChartView` in `ChartRenderer.tsx`, capped at 8 slices — beyond that it
silently falls back to bar, since an unreadable pie serves nobody even if
technically what was asked for). 6 new Python tests cover the override
behavior, including the case where the request can't be satisfied by the
shape (e.g. "pie chart of total revenue" over a single number correctly
degrades to `kpi`, not a meaningless one-slice pie).

**The SSE stream could hang the UI forever with no error shown.**
`ask_stream()` had no exception handling — any unhandled failure anywhere
in the pipeline (confirmed live: Gemini 503 rate-limited AND the Ollama
fallback also down, `httpx.ConnectError`/`404`) propagated straight out of
the generator, FastAPI's `StreamingResponse` just cut the connection, and
the frontend's fetch reader waited on a chunk that would never arrive —
since no terminal event was ever sent, the docstring's claim ("always ends
with clarification, error, or done") wasn't actually true, just true in
the cases that happened to get tested. Fixed with a try/except around the
whole generator body that yields a proper `{"stage": "error", ...}` event
on any exception (full traceback still goes to the server log via
`logger.exception`, only a plain message reaches the user — the raw
exception text used to leak through, e.g. `"Client error '404 Not Found'
for url 'http://localhost:11434/...'"`, not acceptable to show an end
user). Added a client-side idle timeout in `lib/api.ts` too (45s, resets
on every chunk) as defense against a genuine network stall that isn't an
application-level exception at all — a dropped connection with no error
and no more data, which the try/except alone can't catch since nothing
throws.

**Long category names clipped in rotated bar-chart axis labels** — a
multi-hour real debugging chase, not a quick fix, because three different
plausible-looking theories were each wrong in turn: (1) assumed it was the
SVG's internal `margin.left` — increased it, no change, because measuring
the label's actual DOM bounding box showed it already fit comfortably
within the SVG's reported bounds; (2) assumed it was an ancestor's
`overflow-x` (a real, separate CSS fact confirmed along the way: setting
only `overflow-y: auto` makes the browser compute `overflow-x: auto` too,
per the CSS spec's cross-axis coupling rule — real, but not what was
clipping this) — walking the actual DOM ancestor chain showed every
ancestor was `overflow: visible` except the `<svg>` element itself
(`overflow: hidden`, its browser default); (3) assumed increasing the
`ResponsiveContainer`'s total height would give the clipped label more
room — measured the exact pixel overflow before and after and it was
**identical**, proving Recharts reserves the rotated-label band as a fixed
size (the `XAxis` `height` prop) regardless of the container's overall
height; the extra height silently went entirely to the bars instead. The
actual fix, once measured precisely instead of estimated: the `XAxis`
`height` prop was 70px, real labels' rotated bounding boxes needed up to
~91px — raised to 100px, plus truncating any category name over 18
characters (with the full name still in the tooltip) so the space this
needs is bounded instead of scaling with an arbitrary string length. The
lesson, restated because it mattered three times in this one bug: verify
with actual DOM measurements (`getBoundingClientRect`, computed styles),
not layout-math estimation — every wrong theory here was plausible and
every one was falsified by 30 seconds of real measurement.

### Phase 6 — polish
Langfuse tracing, caching, proactive anomaly detection, README.

---

## Repo layout (suggested)

```
askql/
├── CLAUDE.md
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
- **All company data is simulated.** Always labelled as such — this is a demo company
  (Northbeam), not a real business. Numbers are deterministic and internally
  consistent, not real.
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
      `ingestion/simulate.py`). Real ingestion hit real limits (rate limits, a
      platform-side GitHub endpoint block, only one real product) that fought
      the actual goal of a rich multi-product chatbot demo. Real-ingestion code
      parked, not deleted, in `ingestion/sources/`.
- [ ] Real-data cleaning/dedup/ID-resolution layer — explicitly future scope. No
      real source to design against yet; revisit if/when this integrates real
      sales data.
- [ ] Proactive anomaly alerts: v1 or v2
