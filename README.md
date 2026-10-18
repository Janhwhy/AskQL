<div align="center">

# AskQL

**Governed answers, in plain English.**

Ask a business question. Get a chart, a one-line insight, and the SQL behind it.

</div>

---

## The problem

Dashboards don't fail because they're wrong. They fail because they're **slow to change**.
A business user asks a new question, an analyst builds a new view, and a week later the
question has moved on.

A chatbot over your data is the obvious fix, and the market is full of them. But
text-to-SQL has its own failure mode: **ungoverned answers can't be trusted.** Ask ten
tools what "revenue" means and you get ten different queries. A confidently wrong number
is worse than no number.

## The approach

AskQL puts a **semantic layer** between the question and the database. Each metric is
defined once, in YAML, as a business decision rather than a model guess:

```yaml
metrics:
  revenue:
    description: "Total sales revenue"
    source: sales
    join: "JOIN customers ON customers.customer_id = sales.customer_id JOIN ..."
    time_column: sales.date
    expression: sales.amount
    aggregation: sum
    grain: day
    dimensions: [customers.region, products.category, sales.channel, sales_reps.name]
```

The agent reads these definitions and never sees the raw schema. If a question doesn't
map to a defined metric, it says so instead of improvising. Every answer comes with the
SQL that produced it and the metric definition it applied.

---

## Features

- **Chat** that streams each pipeline stage live over SSE, then renders a chart and a
  one-sentence insight.
- **Ambiguity handling.** Asked *"how's support doing?"*, AskQL asks whether you mean
  tickets opened, resolved, backlog or resolution time, and remembers your answer for
  the rest of the conversation.
- **Follow-ups that keep context.** *"Now the same for 7 days"* changes only the date
  range; *"now as a table"* re-renders the same result without re-querying.
- **Saved chats**: rename, pin, delete, and reopen them, with the agent's context
  intact across server restarts.
- **Reports**: pin any answer to a Power BI-style canvas with multiple pages,
  free-form drag/resize with snapping, per-visual formatting, and rich text boxes.
  Dashboards re-run their SQL on every load, so they always show today's numbers.

---

## How it works

```
question
  → generate_sql   LLM sees governed metric definitions only; may instead
                   ask a clarifying question or refuse an out-of-scope one
  → validate       sqlglot: one SELECT over governed tables, nothing else
  → run_sql        read-only DuckDB connection, external file access disabled
  → correct_sql    on an execution error, feed it back and retry once
  → decide_chart   deterministic: {chart_type, x, y, series} from the result
                   shape, or an explicit request ("as a pie chart")
  → narrate        one sentence, built on pre-computed highs/lows
```

Anything that has a correct answer is computed in code, not left to the LLM: chart
type, which metric a clarification refers to, and the highest/lowest values the
narration cites. The LLM writes SQL and prose; it never draws images or does
arithmetic.

LLM calls go to **Gemini**, with a local **Ollama** model as automatic fallback on any
Gemini failure (quota, network, missing key).

---

## The data

A dashboard-in-a-chat only means something if the numbers move day to day, so AskQL
runs on **Northbeam**, a fully simulated B2B SaaS company: 24 products across 5
categories, regions, sales channels, reps, and a growing customer base. **All of it is
synthetic** and labelled as such.

Every number comes from a seeded, deterministic formula: growth trend × weekday pattern
× seeded noise × rare seeded anomaly days. There's no unseeded randomness anywhere, so
regenerating the history from scratch reproduces it exactly.

| Table | Grows | What it holds |
|---|---|---|
| `products` | frozen | 24 products, 5 categories, price, growth rate |
| `sales_reps` | frozen | 12 reps and their regions |
| `customers` | daily | signups, region, plan tier, churn date |
| `sales` | daily | date, product, customer, channel, quantity, amount |
| `support_tickets` | daily | opened/closed, scoped to each product's own buyers |

Dimensions are never duplicated onto fact rows; a chart by region joins through
`customers` at query time, the same lookup an analyst would do by hand.

**Governed metrics** (`metrics/*.yaml`): `revenue`, `average_deal_size`, `units_sold`,
`new_customers`, `churned_customers`, `active_customers`, `churn_rate`,
`support_tickets_opened`, `support_tickets_resolved`, `support_backlog`,
`avg_resolution_time_days`.

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Storage | **DuckDB** (single file) | Embedded and columnar; sub-second analytical queries with no server |
| Data generation | Deterministic simulation | One generator, run daily by the OS scheduler |
| Semantic layer | YAML + Pydantic | Metrics as code; a malformed definition fails loudly on load |
| Agent | **LangGraph** | Explicit graph with retry, checkpointed per conversation |
| Guardrails | `sqlglot` | SQL is parsed and checked before it runs |
| LLM | Gemini, Ollama fallback | Free tier plus a local fallback that keeps working offline |
| Backend | **FastAPI** + SSE | Real per-stage streaming |
| App storage | SQLite | Chats, dashboards, and agent checkpoints, kept out of DuckDB |
| Frontend | Next.js, React, Tailwind, Recharts | The agent emits chart JSON; charts render client-side |

**Why DuckDB over a warehouse?** Latency is the product thesis. Warehouse cold starts
run 30 seconds or more, which recreates the waiting problem this project exists to
solve. At a few million rows, embedded beats distributed.

---

## Guardrails

- Generated SQL must parse as **exactly one `SELECT`** that reads only the five governed
  tables. Writes, DDL, table functions such as `read_csv(...)`, file paths, and other
  schemas are all rejected.
- Queries run on a **read-only** DuckDB connection with **external access disabled**, so
  even SQL that slipped past validation can't read files or reach the network.
- SQL saved to a dashboard is **re-validated every time it runs**, not trusted because
  it passed once.
- Rich text in reports passes an **allowlist HTML sanitizer** before it is stored.

---

## Getting started

**Prerequisites:** Python 3.11+, Node 20+, and a
[Gemini API key](https://aistudio.google.com/apikey) and/or
[Ollama](https://ollama.com) with a code model pulled (`ollama pull qwen2.5-coder:7b`).

```bash
git clone https://github.com/Janhwhy/AskQL.git
cd AskQL

# 1. Backend
pip install -r requirements.txt
cp .env.example .env              # add GEMINI_API_KEY and/or Ollama settings

# 2. Generate the simulated company's history (a few minutes, run once)
python -m ingestion.run_backfill

# 3. Start the API (http://localhost:8000)
uvicorn api.main:app --reload

# 4. Start the frontend (http://localhost:3000), in a second terminal
cd web
npm install
npm run dev
```

To keep the data growing, schedule `python -m ingestion.run_daily_poll` once a day
(Task Scheduler, cron, or launchd). It's idempotent: re-running a day that already
exists does nothing.

The frontend talks to `http://localhost:8000` by default; set `NEXT_PUBLIC_API_URL` to
point it elsewhere. You can also ask questions without the UI:
`python -m agent.cli`.

---

## Testing

| Command | What it proves | Cost |
|---|---|---|
| `pytest` | SQL validation, metric loading, graph wiring, chart decisions, chats/dashboards API | Free, fast. `tests/test_metrics.py` needs the API stopped, since it opens DuckDB for writing |
| `python -m agent.eval` | ~20 golden scenarios against the **real** LLM and database: right metric, date range, chart type, refusals, clarifications, follow-ups | Real LLM calls; exits 1 on any failure |
| `cd web && npm run test:e2e` | Playwright in a real browser: charts actually draw, pinning, drag/resize, text formatting, saved chats | Needs both servers running |

---

## Project layout

```
agent/        LangGraph agent, SQL validation, chart decision, golden eval
api/          FastAPI app: /chat (SSE), chats, dashboards, HTML sanitizer
ingestion/    simulated company definition, daily generator, backfill
metrics/      governed metric definitions (YAML) and their Pydantic loader
tests/        pytest suite
web/          Next.js frontend and Playwright e2e tests
docs/         design spec and phase plans
data/         DuckDB file, SQLite stores, backups (gitignored)
```

---

## Roadmap

- [x] Simulated company and deterministic daily generator, ~20 months backfilled
- [x] Semantic layer: 11 governed metrics, validated against the live schema
- [x] Agent: SQL generation, validation, self-correction, chart decision, narration,
      ambiguity handling with session memory, follow-up context
- [x] Chat UI with live streaming and saved chats
- [x] Reports: multi-page free-form canvas, formatting, rich text
- [x] Golden eval harness and browser e2e tests
- [ ] Query timeouts and row caps at execution time
- [ ] Latency measurement against the p95 < 1s target
- [ ] Result caching
- [ ] Tracing (Langfuse)
- [ ] Proactive anomaly alerts
- [ ] Authentication, before any public deploy

---

## Known tradeoffs

- **Single-writer DuckDB** caps deployment at one API instance. Scaling past that means
  moving to Postgres. Accepted deliberately in exchange for latency.
- **No database-level permissions.** Validation plus a read-only, no-external-access
  connection substitute for a read-only role.
- **All data is simulated.** Northbeam is a demo company; its numbers are deterministic
  and internally consistent, not real.
- **Text-to-SQL is a crowded category.** The differentiation here is governance and
  ambiguity handling, not the chatbot itself.
