# AskQL — Claude Code Handover

**Read this first. It is the operating context for this repo.**

AskQL is an agentic business-analytics chatbot. A user asks a business question in plain
English; the system generates SQL against a governed metric layer, runs it, picks a chart
type, renders it, and narrates a one-line insight.

Tagline: *governed answers, in plain English.*

Full design rationale lives in `docs/spec.md`. This file is the working brief — what to
build, in what order, and the constraints that must not be violated.

---

## Non-negotiable constraints

These are design decisions already made. Do not change them without asking.

1. **Single process.** DuckDB permits one writer OR many readers, never both across
   processes. Ingestion (APScheduler) runs *inside* the FastAPI app, sharing one
   connection. Do not spawn a separate ingestion worker. Do not add Celery.

2. **The agent never sees raw schema.** It reads YAML metric definitions only. If a
   question doesn't map to a defined metric, the correct behaviour is to say so — never
   to improvise SQL against raw tables.

3. **All generated SQL passes `sqlglot` validation before execution.** `SELECT` only.
   Reject anything else. This is the primary guardrail, not a nice-to-have — DuckDB has
   no role-based permissions to fall back on.

4. **The LLM never generates images.** It outputs structured JSON
   (`{chart_type, x, y, series}`); Recharts renders it client-side.

5. **Synthetic metrics must derive from real data, never `random()`.** Dimensions
   (customer names, regions) may be faked. Metrics may not. See "Data model" below.

6. **Latency budget: p95 under one second.** This is the product thesis. If a change
   pushes past it, flag it rather than absorbing it.

---

## Stack

| Layer | Choice |
|---|---|
| Storage | DuckDB (single file) + Parquet for raw archive |
| Ingestion | `httpx` + APScheduler, in-process |
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

Three layers. Keep them separate in the schema.

### Real (fetched live)
| Source | Endpoint | Auth |
|---|---|---|
| GitHub | `api.github.com` | PAT in env |
| npm | `api.npmjs.org/downloads/point/last-day/{pkg}` | none |
| PyPI | `pypistats.org/api/packages/{pkg}/recent` | none |
| Hacker News | `hacker-news.firebaseio.com/v0/...` | none |

GitHub requires ETag caching — send the previous ETag, and unchanged responses return 304
without consuming rate limit. Without it the 5,000/hr limit goes fast.

GitHub retains only 90 days of events, capped at 300 per repo. No backfill is possible.
Poll continuously and store.

### Derived (computed from real)
```python
revenue      = npm_downloads * RATE_PER_DOWNLOAD   # rate is a config constant
support_cost = open_issues * COST_PER_TICKET
margin       = revenue - support_cost
```
Deterministic. A real usage spike must produce a visible revenue spike.

### Synthetic (generated once, then frozen)
Customer names, regions, sales reps, plan tiers. Use `Faker` with a fixed seed so they
are stable across restarts. These are dimensions for grouping — never metrics.

### Business mapping
| Raw signal | Business meaning |
|---|---|
| npm/PyPI downloads | product usage |
| GitHub stars | new customers |
| GitHub issues opened | support tickets in |
| GitHub issues closed | tickets resolved |
| GitHub PRs merged | features shipped |
| GitHub forks | leads |
| HN mentions | marketing reach |

---

## Semantic layer format

`metrics/*.yaml`:

```yaml
metrics:
  new_customers:
    description: "New users acquiring the product"
    source: github_events
    filter: "event_type = 'WatchEvent'"
    aggregation: count
    grain: day

  revenue:
    description: "Modeled revenue from product usage"
    source: npm_downloads
    expression: "downloads * 0.02"
    grain: day
    note: "Derived metric — usage-based model, not booked revenue"
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

Do not skip ahead. Phase 1 is time-gated — data must accumulate before later phases have
anything to chart.

### Phase 0 — prove the data path
Fetch one repo, write to DuckDB, read it back. Run twice, see two rows. Done.

```python
import duckdb, httpx

con = duckdb.connect("askql.db")
con.execute("""CREATE TABLE IF NOT EXISTS repo_snapshots
               (repo TEXT, stars INT, open_issues INT, captured_at TIMESTAMP)""")

r = httpx.get("https://api.github.com/repos/langchain-ai/langchain",
              headers={"Authorization": f"Bearer {TOKEN}"})
d = r.json()
con.execute("INSERT INTO repo_snapshots VALUES (?, ?, ?, now())",
            [d["full_name"], d["stargazers_count"], d["open_issues_count"]])
```

### Phase 1 — accumulate (start this first, leave it running)
APScheduler inside FastAPI, polling every 15–30 min. ETag caching. All four sources.
Deploy with a persistent volume.

```python
from contextlib import asynccontextmanager
from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import FastAPI
import duckdb

con = duckdb.connect("askql.db")

@asynccontextmanager
async def lifespan(app):
    scheduler = BackgroundScheduler()
    scheduler.add_job(poll_all_sources, "interval", seconds=1800, args=[con])
    scheduler.start()
    yield
    scheduler.shutdown()

app = FastAPI(lifespan=lifespan)
```

Done when: 48 hours unattended, row count climbing.

### Phase 2 — metrics
Write the YAML by hand. Verify each one by hand-writing its SQL and checking the number
is sensible. No LLM involvement yet.

### Phase 3 — minimal agent
One node: question + metrics → SQL. `sqlglot` check. Execute. Return raw JSON. Terminal
testing only, no UI. Ask ten questions; the failures define the next phase.

### Phase 4 — full agent
Add nodes one at a time, testing after each: self-correction, chart decision, narration,
ambiguity clarification.

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
├── docs/spec.md
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
- **Modeled revenue is not real revenue.** Always labelled as derived in output.
- **Text-to-SQL is a crowded category.** The differentiation is governance and ambiguity
  handling, not the chatbot itself.

---

## Open decisions

- [ ] Confirm `askql` is free on npm / GitHub / domain
- [ ] Which repos and packages to track — run the checker script in `docs/spec.md` first
      and pick by events/hour, not stars
- [ ] `RATE_PER_DOWNLOAD` — pick a defensible figure
- [ ] Proactive anomaly alerts: v1 or v2
