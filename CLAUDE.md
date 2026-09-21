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

**Narration hallucinated a wrong "highest" claim — caught from a live
screenshot, not proactive testing.** Asked for "pie chart for sales
revenue by products" (24 rows), the narration confidently stated one
product ($602K) was highest — the real highest was a different product at
$2.69M, 4.5x more, not even close, not a rounding error. Root cause: the
narration LLM was handed a JSON blob of up to 20 rows and asked to eyeball
the max itself — exactly the kind of factual computation this project's
own philosophy already said shouldn't be delegated to LLM judgment when a
deterministic answer exists (same reasoning as `decide_chart` and
`_resolve_clarification` — chosen ad hoc each time a real failure exposed
it, not decided up front). Fixed with `_compute_extremes()`
(`agent/graph.py`): computes the true highest/lowest over the FULL result
set (not just the 20 shown) using the chart's own `y` column, and hands
the LLM a "Pre-computed, verified" fact block instead of the search
problem. Verifying the fix immediately surfaced a second, related
hallucination: even fed the correct top fact, the model added an
unverified extra claim ("followed closely by [product]" — checked against
the DB, that product was actually **9th** of 24, not 2nd, not close).
Tightened the prompt to explicitly forbid ranking any row beyond the
pre-computed ones. Confirmed correct and stable across 3 repeated live
runs after the second fix — the general lesson repeats from the axis-label
bug above: verify the fix actually holds, don't stop at the first
plausible-looking success.

**Chart-type follow-ups** ("now give it as a table" after "pie chart for
top 5 products by sales") reuse the prior turn's SQL/rows instead of
re-querying — `_is_chart_followup()` (`agent/graph.py`) matches a message
that's ONLY a chart-type request via a narrow, anchored regex; anything
with real extra content falls through and is treated as a fresh question,
so a phrasing it doesn't recognize just costs a normal query, it never
answers wrong. On a match, `ask`/`ask_stream` pull the checkpointed prior
turn (same `thread_id` mechanism the ambiguity node already uses),
re-run `decide_chart` on the SAME rows with the new question text, and
reuse the narration as-is (the underlying fact didn't change, only the
view of it did) — no new LLM call, no new DB query, and no risk of the
regenerated SQL silently drifting from the original result. The
checkpointed state is never mutated by this path, so a second follow-up
("now pie again") still reuses the ORIGINAL full-query turn's data, not
a stale intermediate one. Verified live end to end in the browser; also
unit-tested (`test_is_chart_followup_*`, `test_chart_followup_reuses_prior_turn_without_requerying`
in `tests/test_agent_graph.py`) — including a caught real gap ("now pie
again" didn't match the first version of the regex, missing "again" from
the trailing-word list).

**Continuation questions ("now the same for 7 days") — caught from a live
screenshot, a hard SQL error, not proactive testing.** Asking "Show me
daily revenue for the last 14 days" then "now the same for 7 days" on the
same thread produced `Binder Error: Referenced column "units_sold" not
found in FROM clause!` — the follow-up isn't a chart-type-only phrasing
(doesn't match `_is_chart_followup()`), so it fell through to a cold,
context-free fresh question with no idea what "the same" referred to, and
the LLM picked an essentially unrelated metric. Two root causes, both
fixed in `agent/graph.py`:
1. Zero conversational memory outside the narrow chart-followup path.
   Fixed by adding `prior_question`/`prior_sql` to `AgentState` (must be
   declared on the TypedDict — same LangGraph `invoke()`-schema-filtering
   lesson as `clarification_answer` earlier — or the fields are silently
   dropped) and a new `_recent_context_block()` that, whenever a prior
   successful turn exists on the thread, injects the previous question and
   its SQL into `GENERATE_PROMPT` with an explicit instruction: if the
   current question is a continuation ("the same", "that but...", "again",
   or just one changed parameter), keep the SAME metric and shape, change
   only what's explicit; if it's clearly unrelated, ignore the block
   entirely. A worked example was added to the prompt for the "change one
   parameter" case specifically.
2. A separate, adjacent bug this surfaced: the LLM wrote `SUM(units_sold)`
   — `units_sold` is a metric *name*, not a real column (the actual
   `sales` columns are `customer_id`, `amount`, `product_id`, `sale_id`,
   `quantity`; the metric's SQL `expression` is `SUM(quantity)`).
   Tightened `GENERATE_PROMPT`'s rule 1 to explicitly say the metric name
   is never a real column and the SQL must use exactly what's in that
   metric's `expression` field.

Fixing this also surfaced a smaller, related bug in the same code path:
the fresh-question branches of `ask`/`ask_stream` were hardcoding
`clarifications: {}` on every non-clarification, non-chart-followup turn,
silently breaking this file's own claim (see "Agent graph" above) that a
clarification answer is remembered "for the session," not just for the
immediate next turn. Fixed by carrying forward the checkpointed prior
turn's `clarifications` dict instead of resetting it.

Verified live end to end: turn 1 SQL
`SELECT date, SUM(sales.amount) FROM sales WHERE date >= DATE '2026-09-21'
- INTERVAL 14 DAY GROUP BY date`; turn 2 ("now the same for 7 days") SQL
`SELECT date, SUM(sales.amount) FROM sales WHERE date >= DATE '2026-09-21'
- INTERVAL 7 DAY GROUP BY date` — confirmed via direct `curl` to `/chat`
that only the `INTERVAL` value changed, the metric stayed identical. Also
confirmed visually via a Playwright screenshot showing a correctly-shaped
7-day revenue line chart. Unit-tested
(`test_continuation_question_gets_prior_turn_as_context` in
`tests/test_agent_graph.py`) — asserts the turn-2 prompt contains both the
prior question text and a fragment of the prior SQL, and that the
returned SQL stays on `sales.amount` with only the interval changed. All
43 tests pass.

### Phase 6 — polish

**Golden eval harness (`agent/eval.py`), added out of order — before
Langfuse/caching/anomaly detection below.** Every bug in Phases 3-5 above
was found the same way: a human eyeballing a live screenshot AFTER the
bug shipped, one at a time. `tests/test_agent_graph.py` mocks
`generate()`, so it only proves the LangGraph wiring is correct — retries,
routing, checkpointing — never that the LLM actually writes the right SQL
for a given English question. That gap is why real regressions (the
metric-name/expression confusion, the missing continuation context) kept
reaching a live screenshot before being caught.

`agent/eval.py` closes it: ~20 realistic scenarios (single-metric
questions, date-range math, grouped breakdowns, both ambiguity cases,
the out-of-scope refusal, explicit chart-type requests, the
metric-name-vs-`expression` trap, the "now the same for 7 days"
continuation case, and the chart-type-follow-up reuse case) run against
the REAL `ask()` — real LLM calls, real DuckDB queries, nothing mocked —
with structural assertions (SQL must/must-not contain certain substrings,
correct chart type, correct refusal/ambiguity behavior, a follow-up's SQL
byte-identical to its prior turn where that's expected) instead of a
human reading JSON. Deliberately loose on exact SQL wording — an LLM's
phrasing varies run to run — so it catches a wrong metric, wrong table,
wrong date range, or wrong chart type, not cosmetic SQL differences.
Run with `python -m agent.eval`; exits 1 if any case fails, usable as a
(slow, real-API-cost) gate, not just an interactive check.

First real run: 19/20 passed; the one failure was a bug in the EVAL's own
assertion, not the agent — it demanded the literal column `opened_at`
appear in the SQL for "tickets opened" with no date range asked, but
rule 2 (an unrequested date filter must be omitted) correctly means that
column never appears when nothing filters on it. `support_tickets_opened`
has no base filter at all (unlike its siblings — `_resolved` and
`_backlog` both filter on `status`, `avg_resolution_time` uses
`date_diff`), so the correct proof it resolved to "opened" specifically
is the ABSENCE of those siblings' distinguishing SQL, not the presence of
a column nothing was filtering on. Fixed the assertion, not the agent;
re-ran that case alone and confirmed the metric resolution itself was
always correct. Also incidentally confirmed the whole run held up
end-to-end running entirely on the Ollama fallback (Gemini's 20/day free
quota was already exhausted for every single call) — real evidence the
fallback path in `agent/llm.py` behaves correctly under actual load, not
just in isolation.

Langfuse tracing, caching, proactive anomaly detection, README — still open.

### Phase 7 — dashboards (done)

User-requested: every answer up to this point was a one-off chat turn: no
way to save a chart or build a persistent multi-chart view, the thing a
real analytics tool (PowerBI/Tableau) is expected to do.

**Backend** (`api/dashboards_db.py` + `api/dashboards.py`, mounted in
`api/main.py`): dashboards and their pinned items live in a **separate
SQLite file** (`data/dashboards.sqlite3`), not a table inside
`data/askql.db`. This is the load-bearing architectural call, not
incidental — constraint 1 (DuckDB single writer, never contending with the
daily poll job) would otherwise mean every "pin a chart" click needs a write
connection to the same analytical file the poll job also writes to.
Dashboard/layout metadata is small and user-driven, so keeping it in its
own SQLite file (stdlib `sqlite3`, same "no ORM for two small tables"
reasoning as DuckDB's own `duckdb` API usage) sidesteps the constraint
entirely instead of working around it. A pinned item stores only
`question`/`sql`/chart-shape/`narration` — never a data snapshot;
`GET /dashboards/{id}` re-runs each item's stored SQL against the live,
read-only DuckDB connection on every load, so a dashboard reflects today's
numbers, not the numbers at pin time. Every piece of SQL that reaches this
router — freshly pinned OR re-run from storage — goes back through
`validate_select_only` before it ever executes; constraint 3 doesn't carve
out an exception for SQL the agent already validated once, since a stored
item's SQL is untrusted input again the moment it's read back.

**Frontend**: `PinButton` (`web/components/chat/PinButton.tsx`) on any
chat answer with a chart — pick an existing dashboard or create one inline.
`/dashboards` lists them; `/dashboards/[id]` renders a `react-grid-layout`
grid (`DashboardGrid`/`DashboardTile`) — drag to rearrange, resize per
tile, remove a tile, layout persists via `PUT /dashboards/{id}/layout`
(optimistic locally, fire-and-forget to the backend — a failed layout save
is low-stakes, worst case a rearrange is lost on next load, not worth
interrupting the user over).

**Two real bugs found live, not proactively** (both root-caused via direct
DOM/computed-style inspection, not guessed at from screenshots alone):

- **A ResizeObserver feedback loop silently corrupted every chart inside a
  dashboard tile.** The first version measured the tile's own content div
  with a JS `ResizeObserver` and fed that pixel height back into the chart
  rendered INSIDE that same div — a feedback loop (observed size depends on
  content that is itself sized by the observed value). The rendered SVG
  paths had completely valid geometry, real colors, `opacity: 1` — by every
  DOM inspection they should have been visible — yet nothing drew. Root
  cause confirmed via `getComputedStyle`: the line's `stroke-dasharray` was
  stuck at a mismatched two-value state (`"550.857px, 600.907px"`) instead
  of either its start state or its finished state, consistent with the
  chart's entrance animation restarting mid-flight every time the observer
  fired. Fixed by removing the custom observer entirely and passing
  Recharts' own `ResponsiveContainer` a CSS percentage (`height="100%"`)
  instead of a JS-measured pixel value, letting Recharts own its own
  resize-observation against the flex-sized parent — the way the library
  is actually designed to be used.
- **A second, independent bug surfaced by the same fix**: `height="100%"`
  only resolves through ancestors with a DEFINITE height. The pie chart's
  and the "1:1-series" bar chart's wrapper markup was a plain `<div>` (for
  the manual legend below the chart) — a plain block div's height is
  `auto`, which breaks the percentage chain. Confirmed via direct
  measurement: Recharts' own `.recharts-responsive-container` ended up
  with a literal computed `height: 0`, so the pie legitimately had zero
  pixels to draw into (0 sectors in the DOM), while the line chart (no
  wrapping div) was unaffected by this specific issue. Fixed by making
  each wrapper a `flex h-full flex-col` with the chart itself in a
  `min-h-0 flex-1` child — a flex item's height IS definite after layout,
  so the percentage resolves correctly through it, in both the dashboard
  tile (`height="100%"`) and chat (`height={280}`) cases. Also disabled
  `isAnimationActive` on every `Line`/`Bar`/`Pie` — the draw-in animation
  has no reason to survive a container that can legitimately resize right
  after mount (exactly what a grid tile does), and it's what got corrupted
  by the first bug in the first place.

Verified: backend CRUD + live re-run + SQL-rejection-on-pin round-tripped
via `TestClient` (create dashboard, pin a chart, reject a `DELETE FROM
sales` pin attempt with 400, fetch with live data, update layout, remove
item, delete dashboard, confirm 404 after). Frontend verified live in the
browser end to end: asked two real questions (a line chart, a pie chart),
pinned both to a new dashboard, confirmed the grid renders both fully
(not just axes/legends — the actual line stroke and pie wedges), dragged a
tile to rearrange, confirmed the new layout survives a full page reload.
`npx tsc --noEmit` and `npm run lint` clean; all 43 pytest tests still
pass.

**Two more real bugs, reported live right after shipping Phase 7 — not
proactively found:**

- **"Table of top 10 products" rendered as a bar chart.** `decide_chart`'s
  explicit-request regex for every OTHER chart type matches its bare
  keyword (`\bpie\b`, `\bbar\s*(chart|graph)\b`, etc.), but the table
  pattern only matched fixed phrases — `"as a table"`, `"table view"`,
  `"in a table"`, `"raw table"` — and never the bare word `"table"` by
  itself. "Table of top 10 products" doesn't contain any of those phrases,
  so it silently fell through to shape-based inference, which picked `bar`
  for a categorical+numeric result — the same class of bug (`decide_chart`
  never reading the question) already fixed once for pie in Phase 5, just
  missed for table specifically. Fixed
  (`agent/chart.py`'s `_CHART_TYPE_PATTERNS`) by matching the bare word
  `table` (plus `raw data`/`raw rows`, which don't contain the word
  "table" and still need their own alternatives). Regression test added
  (`test_bare_word_table_request_is_recognized` in `tests/test_chart.py`)
  covering "table of...", "give me a table", and "...table" as a trailing
  word — all 44 pytest tests pass. Verified live via a direct `/chat`
  call: `chart_type: "table"` for the exact reported phrasing.
- **Dashboard tiles were only draggable from a ~20px title sliver.** The
  chart body itself carried a `no-drag` class (added alongside the
  ResizeObserver fix above, for an unrelated reason — to stop
  `react-grid-layout` from treating an in-chart interaction as a drag
  start) — the actual effect was that dragging from where a user
  naturally tries first (the chart itself) did nothing, so the feature
  read as broken even though the plumbing (`onLayoutChange` ->
  `PUT .../layout`) always worked. Fixed by making the WHOLE tile a drag
  surface (`cursor-grab`/`active:cursor-grabbing` on the card) and scoping
  `no-drag` down to just the remove button — a table tile's own internal
  scroll is unaffected since mouse-wheel scrolling doesn't trigger
  `react-draggable`'s mousedown-based drag start. Verified live: dragged a
  tile by clicking directly on a table ROW (not the header) and confirmed
  it moved and the new position survived a reload.

**The actual fix, called out explicitly: real end-to-end browser test
coverage for the frontend (`web/e2e/dashboard.spec.ts`, Playwright).**
Every bug in this Phase 7 section — the ResizeObserver feedback loop, the
percentage-height chain, the table-vs-bar regex gap, the 20px drag
sliver — was found by a human clicking around a live browser, never by
anything that runs automatically. `agent/eval.py` (Phase 6) closed that
gap for the agent's SQL/chart-type-decision logic; it has no way to catch
a chart that decided the right type but renders empty, or a drag
interaction that silently does nothing, because those aren't agent bugs,
they're frontend rendering/interaction bugs. Added `@playwright/test` +
`web/playwright.config.ts` + `web/e2e/dashboard.spec.ts` as the frontend
counterpart: real assertions against real DOM state in a real browser
(`npm run test:e2e`, requires both dev servers already running). Two
tests: one pins the exact "table of X" phrasing from the bug above and
asserts an actual `<table>` renders (not `.recharts-wrapper`); the other
pins a chart, asserts its SVG path has both a non-trivial `d` attribute
AND a non-trivial rendered bounding-box width (checking `d` length alone
would NOT have caught the ResizeObserver bug — that bug's broken state
still had a plausible-looking `d` string), then drags a tile by clicking
a point inside its BODY (not the header) and asserts the position changed
and survives a reload.

Immediately caught a real bug in the TEST ITSELF, not the app — worth
recording since it's the same discipline this file keeps asking for:
verify the fix actually holds, don't stop at the first result. First run:
the drag assertion failed (`afterStyle === beforeStyle`, no change at
all). Before concluding the drag was broken, checked what was actually
happening with `document.elementFromPoint` at the computed drag-start
coordinate — it returned `null`. The default Playwright viewport
(1280×720) was smaller than the dashboard tile being dragged (which
extended to y≈863), so the drag's start point was below the fold,
entirely outside the viewport — `mouse.move`/`mouse.down` at an
off-viewport coordinate hits nothing, so no drag ever started. Not an app
bug: confirmed by re-running the identical drag against a live dashboard
with a larger viewport (1600×1200) via a throwaway debug script — same
coordinates-relative-to-tile, drag registered immediately
(`.react-grid-placeholder` appeared, position changed). Fixed the TEST
(bigger `viewport` in `playwright.config.ts`, `scrollIntoViewIfNeeded()`
before computing drag coordinates) rather than the app. Both tests pass
after the fix.

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
- Any change to chart rendering, dashboard grid/drag, or the pin flow needs a
  `web/e2e/*.spec.ts` case (`npm run test:e2e`, real browser, real DOM
  assertions) — every one of Phase 7's bugs was a frontend rendering/interaction
  bug that `agent/eval.py` structurally cannot see, since it never touches a
  browser

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
