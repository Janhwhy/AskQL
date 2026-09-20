"""Phase 4 — full agent graph.

question -> generate_sql -> run_sql -+-> (error, retries==0) -> correct_sql -> run_sql
                                      +-> (error, retries>=1) -> END (honest failure)
                                      +-> (success)            -> decide_chart -> narrate -> END

generate_sql can also end the graph early via two sentinels the LLM may output
instead of SQL:
  - NO_METRIC:   no listed metric answers the question -> say so, don't guess
  - AMBIGUOUS:   2+ metrics plausibly match -> ask the user, don't guess
                 (CLAUDE.md: "the project's differentiator... build it properly")

Ambiguity resolution is remembered across calls that share a `thread_id`, via
LangGraph's own MemorySaver checkpointer -- not a hand-rolled session store.
"""

import re
from datetime import date
from typing import Optional, TypedDict

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, StateGraph

from ingestion.db import get_connection
from metrics.loader import load_metrics

from .chart import ChartDecision, decide_chart
from .context import clarifications_block, metrics_context
from .llm import generate
from .validation import UnsafeSQLError, validate_select_only

NO_METRIC_SENTINEL = "NO_METRIC:"
AMBIGUOUS_SENTINEL = "AMBIGUOUS:"
MAX_RETRIES = 1

GENERATE_PROMPT = """You are a SQL generator for a business analytics tool. Output must run on DuckDB.

You may ONLY use the metrics defined below — never invent a table, column, join, or
filter that isn't listed here, even if you've seen it on a DIFFERENT metric.

{context}

{clarifications}

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
   {no_metric_sentinel} <one sentence reason>
7. If two or more DIFFERENT metrics could plausibly answer this question and the
   question doesn't say which one it means (and it isn't already resolved in the
   "Already clarified" list above), do NOT guess. Output exactly:
   {ambiguous_sentinel} <one short clarifying question to ask the user> | <comma-separated candidate metric names>

Example (aggregate, date-filtered):
Q: "How many new customers signed up yesterday?"
SELECT COUNT(*) FROM customers WHERE signed_up_at = DATE '{today}' - INTERVAL 1 DAY

Example (grouped by a listed dimension):
Q: "Revenue by region, last 7 days?"
SELECT customers.region, SUM(sales.amount) FROM sales JOIN customers ON customers.customer_id = sales.customer_id WHERE sales.date >= DATE '{today}' - INTERVAL 7 DAY GROUP BY customers.region

Example (ambiguous):
Q: "How's support doing?"
{ambiguous_sentinel} Do you mean tickets opened, tickets resolved, or the current backlog? | support_tickets_opened, support_tickets_resolved, support_backlog

Question: {question}
SQL:"""

CORRECT_PROMPT = """The SQL you generated failed. Fix ONLY the SQL, using the same
metric definitions as before — do not switch to a different metric.

{context}

Original question: {question}

SQL that failed:
{failed_sql}

Error:
{error}

Output ONLY the corrected raw SQL: one statement, no markdown fences, no explanation."""

NARRATE_PROMPT = """Question: {question}
SQL used: {sql}
Result columns: {columns}
Result rows (first 20): {rows}

Write exactly ONE sentence of plain-English insight a business user would care about.
Reference at least one actual number from the results. No preamble, no markdown."""


class AgentState(TypedDict):
    question: str
    sql: Optional[str]
    error: Optional[str]
    rows: Optional[list]
    columns: Optional[list]
    retries: int
    chart: Optional[ChartDecision]
    narration: Optional[str]
    pending_clarification: Optional[dict]
    clarifications: dict[str, str]


def _strip_code_fence(text: str) -> str:
    text = text.strip()
    match = re.match(r"^```(?:sql)?\s*(.*?)\s*```$", text, re.DOTALL | re.IGNORECASE)
    return match.group(1).strip() if match else text


def _default_json(o):
    if isinstance(o, date):
        return o.isoformat()
    return str(o)


def generate_sql(state: AgentState) -> AgentState:
    metrics = load_metrics()
    context = metrics_context(metrics)

    # A resolved clarification answer arrives via `question` on the re-invoke
    # (see `ask()`) — fold it into session memory before regenerating.
    clarifications = dict(state.get("clarifications") or {})
    pending = state.get("pending_clarification")
    if pending and state.get("_clarification_answer"):
        clarifications[pending["key"]] = state["_clarification_answer"]

    prompt = GENERATE_PROMPT.format(
        context=context,
        clarifications=clarifications_block(clarifications),
        question=state["question"],
        no_metric_sentinel=NO_METRIC_SENTINEL,
        ambiguous_sentinel=AMBIGUOUS_SENTINEL,
        today=date.today().isoformat(),
    )

    raw = generate(prompt)
    text = _strip_code_fence(raw)

    if text.startswith(NO_METRIC_SENTINEL):
        return {
            **state,
            "sql": None,
            "error": text[len(NO_METRIC_SENTINEL):].strip(),
            "rows": None,
            "columns": None,
            "clarifications": clarifications,
            "pending_clarification": None,
        }

    if text.startswith(AMBIGUOUS_SENTINEL):
        body = text[len(AMBIGUOUS_SENTINEL):].strip()
        question_part, _, candidates_part = body.partition("|")
        key = candidates_part.strip() or question_part.strip()
        return {
            **state,
            "sql": None,
            "error": None,
            "rows": None,
            "columns": None,
            "clarifications": clarifications,
            "pending_clarification": {
                "question": question_part.strip(),
                "candidates": [c.strip() for c in candidates_part.split(",") if c.strip()],
                "key": key,
            },
        }

    return {**state, "sql": text, "clarifications": clarifications, "pending_clarification": None}


def run_sql(state: AgentState) -> AgentState:
    text = state["sql"]
    try:
        validate_select_only(text)
    except UnsafeSQLError as e:
        return {**state, "error": f"rejected by SQL validator: {e}", "rows": None, "columns": None}

    con = get_connection(read_only=True)
    try:
        result = con.execute(text)
        rows = result.fetchall()
        columns = [c[0] for c in result.description]
    except Exception as e:
        return {**state, "error": f"execution failed: {e}", "rows": None, "columns": None}
    finally:
        con.close()

    return {**state, "error": None, "rows": rows, "columns": columns}


def correct_sql(state: AgentState) -> AgentState:
    metrics = load_metrics()
    context = metrics_context(metrics)
    prompt = CORRECT_PROMPT.format(
        context=context, question=state["question"], failed_sql=state["sql"], error=state["error"]
    )
    raw = generate(prompt)
    text = _strip_code_fence(raw)
    return {**state, "sql": text, "retries": state["retries"] + 1}


def decide_chart_node(state: AgentState) -> AgentState:
    chart = decide_chart(state["columns"], state["rows"])
    return {**state, "chart": chart}


def narrate(state: AgentState) -> AgentState:
    import json

    prompt = NARRATE_PROMPT.format(
        question=state["question"],
        sql=state["sql"],
        columns=state["columns"],
        rows=json.dumps(state["rows"][:20], default=_default_json),
    )
    text = generate(prompt).strip()
    return {**state, "narration": text}


def _route_after_generate(state: AgentState) -> str:
    if state.get("pending_clarification") is not None:
        return END
    if state["sql"] is None:
        return END  # NO_METRIC
    return "run_sql"


def _route_after_run(state: AgentState) -> str:
    if state["error"] is None:
        return "decide_chart"
    if state["retries"] < MAX_RETRIES:
        return "correct_sql"
    return END  # give up honestly after one retry


def build_graph():
    graph = StateGraph(AgentState)
    graph.add_node("generate_sql", generate_sql)
    graph.add_node("run_sql", run_sql)
    graph.add_node("correct_sql", correct_sql)
    graph.add_node("decide_chart", decide_chart_node)
    graph.add_node("narrate", narrate)

    graph.set_entry_point("generate_sql")
    graph.add_conditional_edges("generate_sql", _route_after_generate, {"run_sql": "run_sql", END: END})
    graph.add_conditional_edges(
        "run_sql", _route_after_run, {"decide_chart": "decide_chart", "correct_sql": "correct_sql", END: END}
    )
    graph.add_edge("correct_sql", "run_sql")
    graph.add_edge("decide_chart", "narrate")
    graph.add_edge("narrate", END)

    return graph.compile(checkpointer=MemorySaver())


_GRAPH = None


def _graph():
    global _GRAPH
    if _GRAPH is None:
        _GRAPH = build_graph()
    return _GRAPH


def ask(question: str, thread_id: Optional[str] = None, clarification_answer: Optional[str] = None) -> dict:
    """Main entry point.

    - `thread_id` absent: today's stateless one-shot behavior (each call is
      independent — no clarification memory).
    - `thread_id` present: ambiguity resolutions persist across calls sharing
      that id, via the graph's checkpointer.
    - `clarification_answer` present: resolves the `pending_clarification`
      recorded on this thread's last turn, then re-asks the *original*
      question (retrieved from checkpointed state, `question` arg is ignored
      in this case).
    """
    app = _graph()
    config = {"configurable": {"thread_id": thread_id or "__stateless__"}}

    if clarification_answer is not None and thread_id is not None:
        prior = app.get_state(config).values
        question = prior.get("question", question)
        state_in = {**prior, "question": question, "_clarification_answer": clarification_answer}
    else:
        state_in = {
            "question": question,
            "sql": None,
            "error": None,
            "rows": None,
            "columns": None,
            "retries": 0,
            "chart": None,
            "narration": None,
            "pending_clarification": None,
            "clarifications": {},
        }

    result = app.invoke(state_in, config=config)

    if result.get("pending_clarification"):
        return {
            "question": question,
            "sql": None,
            "clarification_needed": result["pending_clarification"]["question"],
            "candidates": result["pending_clarification"]["candidates"],
        }

    if result["rows"] is None:
        return {"question": question, "sql": result["sql"], "error": result["error"]}

    return {
        "question": question,
        "sql": result["sql"],
        "columns": result["columns"],
        "rows": [dict(zip(result["columns"], r)) for r in result["rows"]],
        "chart": result["chart"],
        "narration": result["narration"],
        "retries": result["retries"],
    }
