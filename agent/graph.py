"""Phase 3 — minimal agent. One node: question + metrics -> SQL -> validate
-> execute -> raw JSON. Terminal testing only, no UI (CLAUDE.md build order).
Self-correction, chart decision, narration, and ambiguity clarification are
Phase 4 — deliberately not built yet.
"""

import re
from typing import Optional, TypedDict

from langgraph.graph import END, StateGraph

from ingestion.db import get_connection
from metrics.loader import load_metrics

from .context import metrics_context
from .llm import generate
from .validation import UnsafeSQLError, validate_select_only

NO_METRIC_SENTINEL = "NO_METRIC:"

PROMPT_TEMPLATE = """You are a SQL generator for a business analytics tool. Output must run on DuckDB.

You may ONLY use the metrics defined below — never invent a table, column, join, or
filter that isn't listed here, even if you've seen it on a DIFFERENT metric.

{context}

Rules:
1. Pick exactly ONE metric. Use its `source`, `join`, `expression`, and base filter
   EXACTLY as listed — do not add, remove, or combine anything from another metric.
   If a metric has no `join` listed, do not reference any table other than its `source`.
2. You may add a date range condition on the metric's `time_column`. Today's date is
   {today}. Use these exact definitions, do not guess:
   - "yesterday" = {today} minus 1 day
   - "this month" = from the 1st of {today}'s month through {today} (not last month)
   - "last N days" = from {today} minus N days through {today}
3. DuckDB date syntax only — never MySQL/Postgres-specific functions:
   - subtract: `time_column >= DATE '{today}' - INTERVAL 30 DAY`
   - date diff in days: `date_diff('day', start_col, end_col)` (DuckDB arg order:
     unit, start, end — NOT `DATEDIFF(end, start)`)
   - never use `DATE_SUB(...)` — it does not exist in DuckDB.
4. You may GROUP BY one of that metric's listed "allowed group-by dimensions" if the
   question asks for a breakdown — never any other column.
5. Output ONLY the raw SQL: one statement, no markdown fences, no explanation, no
   trailing semicolon-separated extra statements.
6. If no metric here actually answers the question, output exactly:
   {sentinel} <one sentence reason>

Example (aggregate, date-filtered):
Q: "How many new customers signed up yesterday?"
SELECT COUNT(*) FROM customers WHERE signed_up_at = DATE '{today}' - INTERVAL 1 DAY

Example (grouped by a listed dimension):
Q: "Revenue by region, last 7 days?"
SELECT customers.region, SUM(sales.amount) FROM sales JOIN customers ON customers.customer_id = sales.customer_id WHERE sales.date >= DATE '{today}' - INTERVAL 7 DAY GROUP BY customers.region

Question: {question}
SQL:"""


class AgentState(TypedDict):
    question: str
    sql: Optional[str]
    error: Optional[str]
    rows: Optional[list]
    columns: Optional[list]


def _strip_code_fence(text: str) -> str:
    text = text.strip()
    match = re.match(r"^```(?:sql)?\s*(.*?)\s*```$", text, re.DOTALL | re.IGNORECASE)
    return match.group(1).strip() if match else text


def generate_and_execute(state: AgentState) -> AgentState:
    from datetime import date

    metrics = load_metrics()
    context = metrics_context(metrics)
    prompt = PROMPT_TEMPLATE.format(
        context=context, question=state["question"], sentinel=NO_METRIC_SENTINEL, today=date.today().isoformat()
    )

    raw = generate(prompt)
    text = _strip_code_fence(raw)

    if text.startswith(NO_METRIC_SENTINEL):
        return {**state, "sql": None, "error": text[len(NO_METRIC_SENTINEL):].strip(), "rows": None, "columns": None}

    try:
        validate_select_only(text)
    except UnsafeSQLError as e:
        return {**state, "sql": text, "error": f"rejected by SQL validator: {e}", "rows": None, "columns": None}

    con = get_connection(read_only=True)
    try:
        result = con.execute(text)
        rows = result.fetchall()
        columns = [c[0] for c in result.description]
    except Exception as e:
        return {**state, "sql": text, "error": f"execution failed: {e}", "rows": None, "columns": None}
    finally:
        con.close()

    return {**state, "sql": text, "error": None, "rows": rows, "columns": columns}


def build_graph():
    graph = StateGraph(AgentState)
    graph.add_node("generate_and_execute", generate_and_execute)
    graph.set_entry_point("generate_and_execute")
    graph.add_edge("generate_and_execute", END)
    return graph.compile()


def ask(question: str) -> dict:
    """Terminal-testing entry point. Returns raw JSON-able dict per CLAUDE.md
    Phase 3 — no chart decision, no narration, that's Phase 4."""
    app = build_graph()
    result = app.invoke(
        {"question": question, "sql": None, "error": None, "rows": None, "columns": None}
    )
    if result["rows"] is None:
        return {"question": question, "sql": result["sql"], "error": result["error"]}
    return {
        "question": question,
        "sql": result["sql"],
        "columns": result["columns"],
        "rows": [dict(zip(result["columns"], r)) for r in result["rows"]],
    }
