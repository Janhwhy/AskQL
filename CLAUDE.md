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

### Phase 5 — frontend
Next.js chat, Recharts, SSE streaming. Built last because the agent's output contract is
stable by then.

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
