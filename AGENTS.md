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

### Phase 6 — polish
Langfuse tracing, caching, proactive anomaly detection, README.

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
