<div align="center">

# AskQL

**Governed answers, in plain English.**

Ask a business question. Get a chart, an insight, and the SQL behind it — in under a second.

![status](https://img.shields.io/badge/status-in%20development-orange)
![python](https://img.shields.io/badge/python-3.11+-blue)
![license](https://img.shields.io/badge/license-MIT-green)

</div>

---

## The problem

Dashboards don't fail because they're wrong. They fail because they're **slow to change**.

A business user asks a new question. An analyst builds a new view. A week passes. By then
the question has moved on.

The obvious fix is a chatbot over your data — and the market is full of them. But
text-to-SQL has its own failure mode: **ungoverned answers can't be trusted.** Ask ten
tools what "revenue" means and you'll get ten different queries. A confidently wrong
number is worse than no number at all.

## The approach

AskQL puts a **semantic layer** between the question and the database.

Metrics are defined once, in YAML, as a business decision — not a model guess:

```yaml
metrics:
  revenue:
    description: "Total sales revenue"
    source: sales
    join: "sales JOIN customers ON customers.customer_id = sales.customer_id"
    expression: "SUM(sales.amount)"
    group_by: ["customers.region", "products.category"]
    grain: day
```

The agent reads these definitions. It never sees the raw schema. If a question doesn't
map to a defined metric, it says so instead of improvising.

Every answer ships with the SQL that produced it and the metric definition it applied.

---

## How it works

```
question
  → router            classify intent
  → metric retrieval  vector search over metric definitions
  → ambiguity check   if 2+ metrics match, ask instead of guessing
  → SQL generation
  → validation        sqlglot — SELECT only, everything else rejected
  → execute
  → self-correct      on error, feed it back and retry once
  → chart decision    {chart_type, x, y, series}
  → narration         one line of insight
```

The **ambiguity node** is the part most systems skip. Asked "how's growth?", AskQL
responds *"by growth do you mean downloads or contributors?"* — and remembers the answer
for the rest of the session.

---

## The data

A demo on a static CSV undercuts the whole premise — a dashboard-in-a-chat only means
something if the numbers actually move day to day. So AskQL runs on **Northbeam**, a
fully simulated B2B SaaS company: 24 products across 5 categories, regions, sales
channels, reps, and a growing customer base, all clearly labelled as synthetic.

Nothing here is scraped from the internet. Every number comes from a seeded, deterministic
formula — trend + weekday pattern + seeded noise + rare seeded anomaly days — computed
fresh once per day. No `random()` anywhere in the metric path: regenerating the full
history from scratch reproduces it exactly, and a seeded anomaly day is a real event the
bot can explain, not noise.

| Table | Grows | What it holds |
|---|---|---|
| `products` | frozen | 24 products, 5 categories, price, growth rate |
| `customers` | daily | signups, region, plan tier, churn |
| `sales` | daily | date, product, customer, channel, amount |
| `support_tickets` | daily | opened/closed, scoped to each product's own buyers |

Dimensions (region, channel, plan tier) are never duplicated onto fact rows — a chart
grouped by region does a live SQL `JOIN` through `customers` at ask-time, the same lookup
an analyst would do by hand, just in under a second instead of a week.

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Storage | **DuckDB** + Parquet | Embedded, columnar, no server. Sub-second analytical queries |
| Ingestion | `httpx` + APScheduler | Runs in-process — DuckDB allows one writer only |
| Semantic layer | YAML + Pydantic | Metric definitions as code |
| Retrieval | DuckDB VSS | Only relevant metrics enter the prompt |
| Agent | **LangGraph** | Multi-node graph with self-correction |
| Guardrails | `sqlglot` | SELECT-only validation before execution |
| Backend | **FastAPI** + SSE | Token-streamed responses |
| Frontend | Next.js, Recharts, Tailwind | Agent emits JSON; charts render client-side |
| Tracing | Langfuse | Every node, every query, every failure |

**Why DuckDB over Databricks?** Latency is the product thesis. Databricks cold starts run
30 seconds or more — which recreates exactly the waiting problem this project exists to
solve. At a few million rows, embedded beats distributed.

---

## Guardrails

- Generated SQL is parsed and **rejected unless it's a plain `SELECT`**
- The agent connects **read-only**
- Query timeouts and row limits enforced at the engine
- Derived metrics are always **labelled as modeled**, never presented as booked figures

---

## Status

In active development.

- [x] Design and architecture
- [x] Phase 0/1 — simulated company built: 24 products, daily generator, ~20 months
      of history backfilled, unattended daily scheduler running
- [x] Phase 2 — semantic layer: 10 governed metrics (`metrics/*.yaml`), Pydantic
      validation, tested against the live schema
- [x] Phase 3 — minimal agent: LangGraph node, Gemini + Ollama fallback,
      sqlglot-guarded, read-only execution, 10/10 on the terminal test
- [x] Phase 4 — full agent graph: self-correction (retry once), deterministic
      chart-type decision, narration, ambiguity clarification with session
      memory — 13/13 on the live test suite
- [x] Phase 5 — frontend: Next.js chat UI, real SSE streaming, dark/light
      themes, ambiguity chips, charts via Recharts (`web/`)
- [ ] Phase 6 — tracing, caching, anomaly detection

---

## Getting started

> Setup instructions land once Phase 1 is deployed.

```bash
git clone https://github.com/janhwhy/askql
cd askql
cp .env.example .env        # add your GitHub PAT
pip install -r requirements.txt
uvicorn api.main:app --reload
```

---

## Known tradeoffs

Stated up front rather than discovered later:

- **Single-writer DuckDB** caps deployment at one API instance. Scaling past that means
  moving to Postgres. Accepted deliberately in exchange for latency.
- **No database-level permissions.** `sqlglot` validation substitutes for a read-only
  role.
- **Modeled revenue is not real revenue.** Always labelled as derived.
- **Text-to-SQL is a crowded category.** The differentiation here is governance and
  ambiguity handling — not the chatbot.

---

## License

MIT
