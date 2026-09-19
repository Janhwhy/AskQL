# AskQL — Agentic Business Analytics Chatbot

> **AskQL** — governed answers, in plain English.
>
> Casing: `AskQL` in prose, `askql` for repo slug and package name.
> Still to check: npm, GitHub org, and domain availability (`ask*` and `*ql` are a
> crowded namespace).

---

## 1. The Problem

Companies are moving away from traditional BI dashboards. The complaint isn't that
dashboards are wrong — it's that they're **slow to change**. A business user waits a
week for an analyst to build a new Power BI view, and by then the question has moved on.

What they want instead: ask a question in plain English, get an answer and a chart
immediately.

**This project:** a conversational analytics layer that answers business questions with
generated charts, backed by a governed semantic layer so the answers can be trusted.

---

## 2. The Thesis (what makes it defensible)

Text-to-SQL chatbots are a saturated category. Every BI vendor ships one. The novelty
is **not** the chatbot.

The pitch:

> Dashboards fail because questions change faster than dashboards do.
> Text-to-SQL fails because ungoverned answers can't be trusted.
> AskQL puts a semantic layer between them — every answer traces to a defined
> metric, shows its SQL, and returns in under a second.

Three things carry the differentiation:

### 2.1 The semantic layer
Most text-to-SQL systems point an LLM at a raw schema and hope. That fails in production
because companies don't agree on what words mean. "Revenue" might mean gross, net,
booked, or recognized. The LLM guesses, and a confidently wrong number is worse than no
number.

Metrics are defined once, in YAML, as a business decision — not a model guess. This is
what Looker and dbt built companies on.

### 2.2 Trust mechanics
What kills these tools in real deployments isn't wrong answers — it's that nobody can
tell *which* answers are wrong. So:

- Show the SQL alongside every answer
- Quote the metric definition used
- Flag ambiguity instead of guessing
- Say "I don't have a metric for that" rather than hallucinating one

### 2.3 Latency as a design constraint
Every stack choice (DuckDB over Databricks, pre-aggregation, caching) exists to keep
p95 response time under one second. That ties directly back to the original complaint:
waiting.

### Chosen differentiator
**Ambiguity handling.** Almost every system on the market guesses when a question is
vague. One that asks *"by 'growth' do you mean downloads or contributors?"* and remembers
the answer stands out immediately. Underbuilt, achievable, demos well.

---

## 3. Data Strategy

### 3.1 The constraint
Real companies don't publish live sales data. But a demo on a static CSV undercuts the
whole "no more waiting" pitch. So: **build a fictional company whose metrics are driven
by real, live, public data.**

### 3.2 Three layers

| Layer | Source | Nature |
|---|---|---|
| **Real** | npm, PyPI, GitHub, Hacker News | Fetched live, constantly updating |
| **Derived** | revenue, costs, margin | Computed deterministically *from* real numbers |
| **Synthetic** | customers, regions, reps, plans | Static dimensions, generated once |

### 3.3 The key rule

Synthetic metrics must be **driven by real data, not random.**

```python
# BAD — noise, means nothing
revenue = random.gauss(50000, 10000)

# GOOD — deterministic, traceable
downloads = fetch_npm_downloads()   # real, today
revenue = downloads * RATE_PER_DOWNLOAD
```

Why it matters: a real npm spike produces a revenue spike in the chart, which triggers
the anomaly detector, which makes the chatbot say *"revenue jumped 18%, driven by a usage
surge."* Every number traces back to a real-world event.

Synthetic is fine for **dimensions** (customer names, regions, sales reps) — nobody checks
whether "Acme Corp" is real. It is not fine for **metrics** — people absolutely check
whether numbers move sensibly.

### 3.4 Data sources (all zero-auth except GitHub)

| Source | Endpoint | Auth | Business domain |
|---|---|---|---|
| npm downloads | `api.npmjs.org/downloads/point/last-day/{pkg}` | none | product usage |
| PyPI downloads | `pypistats.org/api/packages/{pkg}/recent` | none | second product line |
| Hacker News | `hacker-news.firebaseio.com/v0/...` | none | marketing reach |
| GitHub | `api.github.com` | token (2 min setup) | engineering + support |

Deliberately excluded: Reddit (OAuth approval friction), Stack Overflow (needs key for
usable limits), Twitter (no viable free tier).

Quick test, no setup required:
```bash
curl "https://api.npmjs.org/downloads/point/last-day/langchain"
```

### 3.5 Business metric mapping

| Raw signal | Business meaning |
|---|---|
| npm / PyPI downloads | product usage, active customers |
| GitHub stars | new customer acquisition |
| GitHub issues opened | support tickets inbound |
| GitHub issues closed | tickets resolved |
| GitHub PRs merged | features shipped |
| GitHub forks | qualified leads |
| HN mentions / points | marketing reach |
| derived: downloads × rate | revenue |
| derived: open issues × cost | support cost |

### 3.6 Which repos / packages to track

Recommended: treat one org as "the company" so cross-product comparisons work naturally.
`langchain-ai` is a strong candidate — active daily, multiple repos, good event mix.

| Repo | Role as "product line" |
|---|---|
| `langchain-ai/langchain` | flagship |
| `langchain-ai/langgraph` | growth product |
| `langchain-ai/langsmith-sdk` | tooling |
| `langchain-ai/langchainjs` | second platform |

**Validate before committing.** Rank candidates by real event volume:

```python
import json, urllib.request, datetime
from collections import Counter

TOKEN = "ghp_your_token_here"

CANDIDATES = [
    "langchain-ai/langchain",
    "langchain-ai/langgraph",
    "vercel/next.js",
    "supabase/supabase",
    "ollama/ollama",
    "duckdb/duckdb",
    "n8n-io/n8n",
]

def get(url):
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {TOKEN}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "repo-check"
    })
    return json.load(urllib.request.urlopen(req))

now = datetime.datetime.now(datetime.timezone.utc)
print(f"{'repo':32} {'stars':>8} {'issues':>7} {'events/hr':>10}  event mix")
print("-" * 95)

for repo in CANDIDATES:
    try:
        meta = get(f"https://api.github.com/repos/{repo}")
        events = get(f"https://api.github.com/repos/{repo}/events?per_page=100")
        if not events:
            print(f"{repo:32} no events"); continue

        oldest = datetime.datetime.fromisoformat(events[-1]["created_at"].replace("Z", "+00:00"))
        hours = max((now - oldest).total_seconds() / 3600, 0.1)
        rate = len(events) / hours
        mix = Counter(e["type"].replace("Event", "") for e in events)
        top = ", ".join(f"{k}:{v}" for k, v in mix.most_common(4))

        print(f"{repo:32} {meta['stargazers_count']:>8} {meta['open_issues_count']:>7} {rate:>10.1f}  {top}")
    except Exception as e:
        print(f"{repo:32} ERROR {e}")
```

Reading the output:
- **events/hr** is the number that matters. Below ~1/hr gives flat, dull charts. Above ~5/hr is comfortable.
- **event mix** should show variety. All `Push` means commit data only — no "support tickets" or "new customers" metric.

Caveat: GitHub retains only the last 90 days of events, capped at 300 per repo. You poll
continuously and store; you cannot backfill history.

---

## 4. Tech Stack

### Data ingestion

| Tool | What it does |
|---|---|
| GitHub REST API | Live events feed plus per-repo stats |
| npm / PyPI / HN APIs | Usage and marketing signals, no auth |
| `httpx` | HTTP client, async so sources poll in parallel |
| APScheduler | Runs the poller on a schedule. **Runs inside FastAPI**, not as a separate worker — this keeps DuckDB to a single writing process |
| ETag caching | Send back the previous ETag; unchanged data returns "not modified" and doesn't count against rate limit. Not optional |

### Storage

| Tool | What it does |
|---|---|
| DuckDB | Embedded columnar database — a Python library, not a server. Single file. Holds raw events and derived metrics |
| Parquet files | Raw event archive. DuckDB queries Parquet directly, giving a bronze/gold split without a warehouse |
| `duckdb` Python API | Replaces SQLAlchemy/Alembic — ergonomic enough that an ORM adds overhead without benefit |

### Semantic layer

| Tool | What it does |
|---|---|
| YAML metric definitions | Metrics defined once. The agent reads these instead of raw column names — this is what stops it inventing columns |
| Pydantic | Validates definitions; forces structured JSON from the LLM instead of prose |
| DuckDB VSS extension | Vector search inside DuckDB — retrieves only relevant metric definitions rather than dumping the whole schema into the prompt |

### Agent layer

| Tool | What it does |
|---|---|
| LangGraph | Orchestrates: router → metric retrieval → SQL generation → self-correction → chart-type choice → narration |
| Claude / GPT API | Reasoning engine inside each node |
| `sqlglot` | Parses generated SQL before running and rejects anything that isn't a plain `SELECT`. With DuckDB this is the **primary** guardrail |

### Backend

| Tool | What it does |
|---|---|
| FastAPI | API server. `/chat` for questions, `/metrics` for raw data. Also hosts the scheduler |
| Server-Sent Events | Streams answers token-by-token so users see typing, not a spinner |
| `functools.lru_cache` | Caches repeated questions. Redis is overkill in a single process |

### Frontend

| Tool | What it does |
|---|---|
| Next.js + React | Chat interface |
| Recharts | Renders charts. The agent outputs structured JSON (chart type + data + labels); the LLM never generates an image, so charts stay interactive |
| Tailwind + shadcn/ui | Styling and prebuilt components |

### Guardrails & observability

| Tool | What it does |
|---|---|
| `sqlglot` SELECT-only validation | Main protection against destructive queries |
| Read-only DuckDB connection | `read_only=True` as a second line of defense |
| DB file backups | The whole database is one file — a scheduled copy is trivial insurance |
| Langfuse | Traces each agent run: which node fired, what SQL it wrote, where it broke |
| Query timeouts + row limits | Stops a bad generated query from hanging the app |

### Deployment

| Tool | What it does |
|---|---|
| Docker | Packages the app. Simpler with no separate DB container |
| Railway / Render / Fly.io | Hosts the backend. Needs a **persistent volume** so the DuckDB file survives restarts |
| Vercel | Hosts the frontend |
| GitHub Actions | CI/CD on push |

---

## 5. Architecture

```
npm / PyPI / HN / GitHub APIs
            │
            │ poll (APScheduler, inside FastAPI)
            ▼
    ┌───────────────────────┐
    │  DuckDB + Parquet     │
    │                       │
    │  real metrics         │  ← fetched
    │  derived metrics      │  ← computed from real
    │  synthetic dimensions │  ← generated once
    └───────────────────────┘
            ▲
            │ read-only connection
            │
User ──> Next.js ──> FastAPI ──> LangGraph agent
                                    ├─ router (intent classification)
                                    ├─ metric retrieval (YAML + VSS)
                                    ├─ ambiguity check ──> clarifying question
                                    ├─ SQL generation
                                    ├─ sqlglot validation
                                    ├─ self-correction on error
                                    ├─ chart-type decision
                                    └─ narration
                                          │
                    JSON {chart_type, data, insight, sql}
                                          │
                                        SSE
                                          ▼
                                      Recharts
```

### Critical constraint
**Everything runs in one process.** DuckDB allows one writer OR many readers, not both
across processes. Merging ingestion into the FastAPI app solves this. The tradeoff: you
cannot scale to multiple API instances without rethinking storage. Fine for a portfolio
project — and knowing the limitation is worth stating explicitly.

```python
from contextlib import asynccontextmanager
from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import FastAPI
import duckdb

con = duckdb.connect("askql.db")   # one connection, shared

@asynccontextmanager
async def lifespan(app):
    scheduler = BackgroundScheduler()
    scheduler.add_job(poll_all_sources, "interval", seconds=1800, args=[con])
    scheduler.start()
    yield
    scheduler.shutdown()

app = FastAPI(lifespan=lifespan)
```

---

## 6. Semantic Layer Format

```yaml
metrics:
  new_customers:
    description: "New users acquiring the product"
    source: github_events
    filter: "event_type = 'WatchEvent'"
    aggregation: count
    grain: day

  product_usage:
    description: "Daily active usage of the product"
    source: npm_downloads
    expression: "downloads"
    grain: day

  support_backlog:
    description: "Open support tickets awaiting resolution"
    source: repo_snapshots
    expression: "open_issues"
    grain: snapshot

  revenue:
    description: "Modeled revenue from product usage"
    source: npm_downloads
    expression: "downloads * 0.02"
    grain: day
    note: "Derived metric — usage-based model, not booked revenue"
```

Write 8–12 of these. For each, the question to answer is: *if someone says this word,
what exactly do I compute?*

---

## 7. Build Plan

### Phase 0 — Prove the data works (1 evening)
1. Get a GitHub personal access token (settings → developer settings → PAT). Raises limit from 60 to 5,000 req/hr.
2. Pick 3–5 repos / packages to track.
3. Fetch one repo's stats, print the JSON.
4. Write it to DuckDB. Query it back.

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

print(con.sql("SELECT * FROM repo_snapshots"))
```

**Done when:** run twice, see two rows.

### Phase 1 — Make it accumulate (weekend 1)
1. Wrap the fetch in APScheduler inside FastAPI (single-process setup above).
2. Poll every 15–30 minutes. Add ETag caching.
3. Add the events feed alongside snapshots.
4. Add npm / PyPI / HN pollers.
5. Deploy with a persistent volume and **leave it running.**

**Done when:** running unattended 48 hours, row count climbing.

> This is the one phase that can't be rushed — you need a week or two of accumulated data
> before "how's growth this month" has anything to chart. **Start this first.**

### Phase 2 — Define metrics (1 day)
Write the YAML semantic layer by hand, before any LLM work. Doing it first forces clarity.

**Done when:** you can hand-write correct SQL for each metric.

### Phase 3 — Dumbest possible agent (weekend 2)
1. One LangGraph node: question + metric YAML → SQL.
2. `sqlglot` check: is it a `SELECT`?
3. Run it, return raw JSON.
4. Test in the terminal, no UI.

Ask ten questions. The ones it gets wrong become the roadmap.

**Done when:** "how many new customers this week" returns a correct number.

### Phase 4 — Real agent (weekend 3)
Add nodes one at a time, testing after each:
1. Self-correction — feed SQL errors back, retry once
2. Chart-type decision — output `{chart_type, x, y}` from result shape
3. Narration — one sentence of insight
4. **Ambiguity clarification** — the differentiator

### Phase 5 — Frontend (weekend 4)
Next.js chat box, Recharts rendering the agent's JSON, SSE streaming.

Built last because the agent's output format is stable by now — building UI against a
changing API is miserable.

### Phase 6 — Polish
Langfuse tracing, caching, proactive anomaly detection, README with the thesis.

### Timeline
Data flowing by day 2 · metrics defined by day 5 · working agent by end of week 2 ·
demo-able by end of week 4.

---

## 8. Things to Say Out Loud (interview / demo)

- "Metrics derive from live public usage data. Dimensional attributes are synthetic.
  Every number moves because something real moved."
- "I chose DuckDB over Databricks because query latency mattered more than scale —
  Databricks cold starts run 30s+, which recreates the problem I'm solving."
- "The agent connects with a read-only connection and every query is SELECT-validated
  before execution."
- "The novelty isn't the chatbot. It's that the answers are governed."
- On the DuckDB tradeoff: "Single-writer constraint means one process. I designed around
  it; scaling past one instance would need Postgres."

---

## 9. Open Decisions

- [x] ~~Final project name~~ — **AskQL**
- [ ] Confirm `askql` is free on npm / GitHub / domain
- [ ] Which org / packages to track (run the checker script first)
- [ ] Revenue model rate — pick a defensible `downloads × rate` figure
- [ ] Whether to add proactive anomaly alerts in v1 or v2
- [ ] Databricks as an upstream processing layer later, or skip entirely
