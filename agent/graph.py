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

import logging
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

logger = logging.getLogger("askql.agent")

NO_METRIC_SENTINEL = "NO_METRIC:"
AMBIGUOUS_SENTINEL = "AMBIGUOUS:"
MAX_RETRIES = 1

# Matches a message that's ONLY a chart-type request ("now give it as a
# table", "show as bar chart", "table") with nothing else in it. Anchored
# both ends, so anything with real extra content ("revenue by region as a
# table") fails to match and falls through to a normal fresh question --
# the reuse path below only ever fires on a genuine narrow match, never a
# guess, so a phrasing this doesn't recognize just costs a normal query,
# it never answers wrong.
_CHART_FOLLOWUP_PATTERN = re.compile(
    r"^\s*(now\s+)?(please\s+)?(give|show|display|make|turn|convert|switch|change)?\s*"
    r"(it|that|this|me)?\s*(as|into|to|in)?\s*(a\s+|an\s+|the\s+)?"
    r"(pie|bar|line|table|kpi)\s*(chart|graph|view)?\s*(instead|please|now|again)?\s*\.?\s*$",
    re.IGNORECASE,
)


def _is_chart_followup(question: Optional[str]) -> bool:
    return bool(question) and bool(_CHART_FOLLOWUP_PATTERN.match(question.strip()))

GENERATE_PROMPT = """You are a SQL generator for a business analytics tool. Output must run on DuckDB.

You may ONLY use the metrics defined below — never invent a table, column, join, or
filter that isn't listed here, even if you've seen it on a DIFFERENT metric.

{context}

{clarifications}
{recent_context}
Rules:
1. Pick exactly ONE metric. Use its `source`, `join`, `expression`, and base filter
   EXACTLY as listed — do not add, remove, or combine anything from another metric.
   If a metric has no `join` listed, do not reference any table other than its `source`.
   The text right after "- " (e.g. "units_sold") is the metric's NAME — it exists so
   YOU can pick the right metric, it is NEVER a real column and must NEVER appear in
   the SQL you output. The SQL must use exactly what's in that metric's `expression`
   field (e.g. `quantity`, not `units_sold`) — a metric named units_sold whose
   expression is `quantity` means `SUM(quantity)`, never `SUM(units_sold)`.
2. A date range condition on the metric's `time_column` is OPTIONAL, even when
   `grain: day` — that field only means a `time_column` EXISTS to filter on if the
   question asks for one. "How many X in total" / "of all time" / no time mentioned
   at all means NO date condition — aggregate over every row, don't refuse and don't
   invent a date range that wasn't asked for.
3. When a date range IS asked for, today's date is {today}. Use these exact
   definitions, do not guess:
   - "yesterday" = {today} minus 1 day
   - "this month" = from the 1st of {today}'s month through {today} (not last month)
   - "last N days" = from {today} minus N days through {today}
4. DuckDB date syntax only — never MySQL/Postgres-specific functions:
   - subtract: `time_column >= DATE '{today}' - INTERVAL 30 DAY`
   - date diff in days: `date_diff('day', start_col, end_col)` (DuckDB arg order:
     unit, start, end — NOT `DATEDIFF(end, start)`)
   - never use `DATE_SUB(...)` — it does not exist in DuckDB.
5. You may GROUP BY one of that metric's listed "allowed group-by dimensions" if the
   question asks for a breakdown — never any other column.
6. Output ONLY the raw SQL: one statement, no markdown fences, no explanation, no
   trailing semicolon-separated extra statements.
7. NO_METRIC vs AMBIGUOUS — these are different, do not confuse them:
   - Use {no_metric_sentinel} <one sentence reason> ONLY when the question's TOPIC
     isn't covered by ANY metric above at all (e.g. weather, headcount, competitors).
   - Use {ambiguous_sentinel} <one short clarifying question> | <comma-separated
     candidate metric names> whenever the topic IS covered but the question is
     vague enough that 2+ metrics could plausibly answer it (e.g. "how's support
     doing" — support IS covered, by four different metrics, so ask which one; do
     NOT call this NO_METRIC just because the question itself doesn't name a
     metric). A vague question about a covered topic is ALWAYS ambiguous, never
     "not covered." Skip this if already resolved in "Already clarified" above.

Example (aggregate, no date range — "in total" means every row):
Q: "How many customers have churned in total?"
SELECT COUNT(*) FROM customers WHERE churned_at IS NOT NULL

Example (aggregate, date-filtered):
Q: "How many new customers signed up yesterday?"
SELECT COUNT(*) FROM customers WHERE signed_up_at = DATE '{today}' - INTERVAL 1 DAY

Example (grouped by a listed dimension):
Q: "Revenue by region, last 7 days?"
SELECT customers.region, SUM(sales.amount) FROM sales JOIN customers ON customers.customer_id = sales.customer_id WHERE sales.date >= DATE '{today}' - INTERVAL 7 DAY GROUP BY customers.region

Example (ambiguous — topic covered, multiple metrics fit, question doesn't say which):
Q: "How's support doing?"
{ambiguous_sentinel} Do you mean tickets opened, tickets resolved, or the current backlog? | support_tickets_opened, support_tickets_resolved, support_backlog

Example (ambiguous — same pattern, a different vague phrasing):
Q: "Tell me about our customers."
{ambiguous_sentinel} Do you want new signups, churn, active customer count, or revenue by customer segment? | new_customers, churned_customers, active_customers, revenue

Example (continuation of the PREVIOUS question — see "Previous question" section
above when present; keep the SAME metric, only change what's explicitly different):
Previous question: "Show me daily revenue for the last 14 days"
Previous SQL: SELECT date, SUM(sales.amount) FROM sales WHERE date >= DATE '{today}' - INTERVAL 14 DAY GROUP BY date
Q: "now the same for 7 days"
SELECT date, SUM(sales.amount) FROM sales WHERE date >= DATE '{today}' - INTERVAL 7 DAY GROUP BY date

Question: {question}
SQL:"""

RESOLVED_PROMPT = """You are a SQL generator for a business analytics tool. Output must run on DuckDB.

The user already told us which metric they want — this is fully resolved, not ambiguous.
Use ONLY this metric, exactly as defined. Do not reconsider other metrics, do not ask
anything else:

{context}

Rules:
1. Use this metric's `source`, `join`, `expression`, and base filter EXACTLY as listed.
2. A date range condition on `time_column` is OPTIONAL — only add one if the question
   asks for a specific period. Today's date is {today}. "in total"/"of all time"/no
   time mentioned means NO date condition.
3. When a date range IS asked for: "yesterday" = {today} minus 1 day, "this month" =
   1st of {today}'s month through {today}, "last N days" = {today} minus N days through {today}.
4. DuckDB date syntax only (`DATE '{today}' - INTERVAL N DAY`, `date_diff('day', a, b)`)
   — never MySQL functions like `DATE_SUB`.
5. You may GROUP BY one of the listed "allowed group-by dimensions" if the question
   asks for a breakdown.
6. Output ONLY the raw SQL: one statement, no markdown fences, no explanation.

Original question: {question}
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
{extremes_block}
Write exactly ONE sentence of plain-English insight a business user would care about.
Reference at least one actual number from the results. If a "Pre-computed" block is
given above, use those figures directly for any highest/lowest claim — do not scan the
rows yourself and recompute them, you will get it wrong on a result this size, and a
wrong highest/lowest claim is worse than a boring but correct one. Do not name or rank
any OTHER row for comparison ("followed by...", "close behind...", second place, etc.)
— only the pre-computed figures above are verified; anything else you'd say about
relative ranking is a guess from a partial, unsorted view and will likely be wrong, as
it already has been. State the one verified fact and stop. No preamble, no markdown."""


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
    clarification_answer: Optional[str]
    prior_question: Optional[str]
    prior_sql: Optional[str]


def _strip_code_fence(text: str) -> str:
    text = text.strip()
    match = re.match(r"^```(?:sql)?\s*(.*?)\s*```$", text, re.DOTALL | re.IGNORECASE)
    return match.group(1).strip() if match else text


def _default_json(o):
    if isinstance(o, date):
        return o.isoformat()
    return str(o)


def _resolve_clarification(answer: str, candidates: list[str], metrics: dict) -> Optional[str]:
    """Deterministic best-effort match of a free-text clarification answer to
    one of the offered candidate metric names, by keyword overlap against
    each candidate's name + description.

    Doing this in code rather than asking the LLM to re-correlate its own
    prior question with a fresh prompt matters in practice — a 7B local
    model (the Ollama fallback) reliably failed to make this connection even
    when the raw answer text was placed directly in its prompt, re-asking
    the same clarifying question instead of resolving it. A plain keyword
    match doesn't have that failure mode. Same philosophy as chart.py's
    decide_chart: deterministic where a deterministic answer exists, don't
    leave it to LLM judgment.
    """
    answer_words = set(re.findall(r"[a-z]+", answer.lower()))
    if not answer_words:
        return None
    best, best_score = None, 0
    for name in candidates:
        metric = metrics.get(name)
        haystack = name.replace("_", " ")
        if metric:
            haystack += " " + metric.description
        haystack_words = set(re.findall(r"[a-z]+", haystack.lower()))
        score = len(answer_words & haystack_words)
        if score > best_score:
            best, best_score = name, score
    return best


def _recent_context_block(prior_question: Optional[str], prior_sql: Optional[str]) -> str:
    """Real bug, caught live: "now the same for 7 days" after "daily
    revenue for the last 14 days" got answered with a different metric
    entirely (units_sold instead of revenue) — the agent had zero memory
    of what "the same" referred to for anything except the narrow
    chart-type-only follow-up path, so a question that only makes sense as
    a continuation got treated as a cold, context-free fresh question.
    Populated by `ask`/`ask_stream` from the checkpointed prior turn
    whenever one exists on this thread; empty string (no block at all)
    when there isn't one, so a genuinely fresh conversation is unaffected.
    """
    if not prior_question or not prior_sql:
        return ""
    return (
        f'Previous question in this conversation: "{prior_question}"\n'
        f"Previous SQL: {prior_sql}\n"
        f'If the current question refers back to this ("the same", "that but...", '
        f'"again", or just changes one parameter like a date range without naming a '
        f"new metric), keep the SAME metric and shape as the previous SQL, changing "
        f"ONLY what's explicitly different. If the current question is clearly about "
        f"something else, ignore this block entirely.\n"
    )


def generate_sql(state: AgentState) -> AgentState:
    metrics = load_metrics()

    # A resolved clarification answer arrives via `clarification_answer` on
    # the re-invoke (see `ask()`). Must be a declared AgentState field, not
    # an ad-hoc key: LangGraph filters invoke() input against the graph's
    # schema, so an undeclared key is silently dropped before any node ever
    # sees it (this broke the whole round-trip until this field was added).
    clarifications = dict(state.get("clarifications") or {})
    pending = state.get("pending_clarification")
    answer = state.get("clarification_answer")

    if pending and answer:
        resolved_name = _resolve_clarification(answer, pending["candidates"], metrics)
        if resolved_name:
            # Fully resolved — narrow the prompt to just this one metric so
            # there's nothing left to be ambiguous about, instead of hoping
            # the LLM notices a clarification block buried in full context.
            prompt = RESOLVED_PROMPT.format(
                context=metrics_context({resolved_name: metrics[resolved_name]}),
                question=state["question"],
                today=date.today().isoformat(),
            )
            raw = generate(prompt)
            text = _strip_code_fence(raw)
            return {**state, "sql": text, "clarifications": clarifications, "pending_clarification": None}
        # Couldn't confidently match the answer to a candidate — fall back
        # to full context with the raw answer noted, best effort.
        clarifications[pending["key"]] = answer

    context = metrics_context(metrics)
    prompt = GENERATE_PROMPT.format(
        context=context,
        clarifications=clarifications_block(clarifications),
        recent_context=_recent_context_block(state.get("prior_question"), state.get("prior_sql")),
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
    chart = decide_chart(state["columns"], state["rows"], question=state["question"])
    return {**state, "chart": chart}


def _compute_extremes(columns: list, rows: list, chart: Optional[ChartDecision]) -> Optional[dict]:
    """Finds the actual highest/lowest row by the chart's own y column,
    over the FULL result set (not just the 20 rows shown to the prompt).

    Real bug, caught from a live screenshot: asked to eyeball "the
    highest" across a 24-row JSON blob, the narration LLM picked a wrong
    row entirely (claimed a product with $602K was highest when another
    had $2.69M — not a rounding error, not close, just wrong). Scanning a
    result set for an extremum is exactly the kind of factual computation
    this project's own philosophy says shouldn't be left to LLM judgment
    when a deterministic answer exists (same reasoning as chart.py's
    decide_chart and graph.py's _resolve_clarification) — so compute it
    here and hand the LLM the fact instead of the search problem.
    """
    if not chart or not chart.get("y") or len(rows) < 2:
        return None
    y, x = chart["y"], chart.get("x")
    try:
        y_idx = columns.index(y)
    except ValueError:
        return None
    x_idx = columns.index(x) if x and x in columns else None

    numeric_rows = [
        (r[x_idx] if x_idx is not None else None, r[y_idx])
        for r in rows
        if isinstance(r[y_idx], (int, float))
    ]
    if not numeric_rows:
        return None

    top = max(numeric_rows, key=lambda r: r[1])
    bottom = min(numeric_rows, key=lambda r: r[1])
    return {"y": y, "x": x, "top": top, "bottom": bottom, "n": len(numeric_rows)}


def narrate(state: AgentState) -> AgentState:
    import json

    extremes = _compute_extremes(state["columns"], state["rows"], state.get("chart"))
    extremes_block = ""
    if extremes:
        label = f" ({extremes['x']})" if extremes["x"] else ""
        extremes_block = (
            f"\nPre-computed, verified against all {extremes['n']} rows (not just the ones shown above):\n"
            f"- highest {extremes['y']}{label}: {extremes['top'][0]!r} = {extremes['top'][1]}\n"
            f"- lowest {extremes['y']}{label}: {extremes['bottom'][0]!r} = {extremes['bottom'][1]}\n"
        )

    prompt = NARRATE_PROMPT.format(
        question=state["question"],
        sql=state["sql"],
        columns=state["columns"],
        rows=json.dumps(state["rows"][:20], default=_default_json),
        extremes_block=extremes_block,
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
    - `question` is ONLY a chart-type change ("now give it as a table") and
      a prior turn's data exists on this thread: reuses that turn's SQL/rows
      instead of re-querying — see `_is_chart_followup`.
    """
    app = _graph()
    config = {"configurable": {"thread_id": thread_id or "__stateless__"}}

    if clarification_answer is None and thread_id is not None and _is_chart_followup(question):
        prior = app.get_state(config).values
        if prior and prior.get("rows") is not None and prior.get("columns"):
            new_chart = decide_chart(prior["columns"], prior["rows"], question=question)
            return {
                "question": question,
                "sql": prior["sql"],
                "columns": prior["columns"],
                "rows": [dict(zip(prior["columns"], r)) for r in prior["rows"]],
                "chart": new_chart,
                "narration": prior.get("narration"),
                "retries": prior.get("retries", 0),
            }

    if clarification_answer is not None and thread_id is not None:
        prior = app.get_state(config).values
        question = prior.get("question", question)
        state_in = {**prior, "question": question, "clarification_answer": clarification_answer}
    else:
        # Real bug, fixed alongside the "recent context" fix below:
        # `clarifications` used to be hardcoded to {} on every fresh
        # question, silently discarding earlier-resolved ambiguities within
        # the SAME thread even though CLAUDE.md's own differentiator claim
        # is that the ambiguity node "remembers the answer for the
        # session" — it only actually remembered within one clarification
        # round-trip, not across separate questions after it.
        prior = app.get_state(config).values if thread_id is not None else None
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
            "clarifications": dict(prior.get("clarifications") or {}) if prior else {},
            "clarification_answer": None,
            "prior_question": prior.get("question") if prior and prior.get("rows") is not None else None,
            "prior_sql": prior.get("sql") if prior and prior.get("rows") is not None else None,
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


def ask_stream(question: Optional[str], thread_id: Optional[str] = None, clarification_answer: Optional[str] = None):
    """Generator version of `ask()` for Phase 5's SSE endpoint. Yields one
    dict per graph step AS IT ACTUALLY HAPPENS, via LangGraph's own
    `.stream(..., stream_mode="updates")` — real node-by-node progress, not
    a fabricated typing effect layered on top of a single blocking call.

    Every yielded dict has a "stage" key. The stream always ends with
    exactly one of: "clarification", "error", or "done".

    Also handles a chart-type-only follow-up ("now give it as a table") on
    an existing thread by reusing the prior turn's SQL/rows/narration
    instead of re-querying — see `_is_chart_followup`. Cheaper (no LLM call,
    no DB query) and more correct: regenerating SQL from scratch for "as a
    table" risks the new query silently drifting from "top 5 products by
    sales" instead of just re-displaying the same answer differently. The
    checkpointed state is never mutated by this path, so a second follow-up
    ("now pie again") still reuses the ORIGINAL full-query turn's data, not
    a stale intermediate one.
    """
    app = _graph()
    config = {"configurable": {"thread_id": thread_id or "__stateless__"}}

    if clarification_answer is None and thread_id is not None and _is_chart_followup(question):
        prior = app.get_state(config).values
        if prior and prior.get("rows") is not None and prior.get("columns"):
            new_chart = decide_chart(prior["columns"], prior["rows"], question=question)
            row_dicts = [dict(zip(prior["columns"], r)) for r in prior["rows"]]
            yield {"stage": "thinking"}
            yield {"stage": "sql", "sql": prior["sql"]}
            yield {"stage": "result", "columns": prior["columns"], "rows": row_dicts}
            yield {"stage": "chart", "chart": new_chart}
            if prior.get("narration"):
                yield {"stage": "narration", "narration": prior["narration"]}
            yield {
                "stage": "done",
                "question": question,
                "sql": prior["sql"],
                "columns": prior["columns"],
                "rows": row_dicts,
                "chart": new_chart,
                "narration": prior.get("narration"),
            }
            return

    if clarification_answer is not None and thread_id is not None:
        prior = app.get_state(config).values
        question = prior.get("question", question)
        state_in = {**prior, "question": question, "clarification_answer": clarification_answer}
    else:
        # See the matching comment in ask() — carries forward
        # clarifications (previously wiped every fresh question, despite
        # the "remembers for the session" claim) and prior_question/
        # prior_sql so generate_sql can correctly treat a continuation
        # like "now the same for 7 days" as one, instead of a cold,
        # context-free fresh question that picks an unrelated metric.
        prior = app.get_state(config).values if thread_id is not None else None
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
            "clarifications": dict(prior.get("clarifications") or {}) if prior else {},
            "clarification_answer": None,
            "prior_question": prior.get("question") if prior and prior.get("rows") is not None else None,
            "prior_sql": prior.get("sql") if prior and prior.get("rows") is not None else None,
        }

    yield {"stage": "thinking"}

    try:
        for update in app.stream(state_in, config=config, stream_mode="updates"):
            for node_name, partial in update.items():
                if node_name == "generate_sql":
                    if partial.get("pending_clarification"):
                        yield {
                            "stage": "clarification",
                            "question": question,
                            "clarification_needed": partial["pending_clarification"]["question"],
                            "candidates": partial["pending_clarification"]["candidates"],
                        }
                        return
                    if partial.get("sql") is None:
                        yield {"stage": "error", "question": question, "error": partial.get("error")}
                        return
                    yield {"stage": "sql", "sql": partial["sql"]}

                elif node_name == "run_sql":
                    if partial.get("error"):
                        if partial.get("retries", 0) < MAX_RETRIES:
                            yield {"stage": "retrying", "error": partial["error"]}
                        else:
                            yield {"stage": "error", "question": question, "sql": partial.get("sql"), "error": partial["error"]}
                            return
                    else:
                        yield {
                            "stage": "result",
                            "columns": partial["columns"],
                            "rows": [dict(zip(partial["columns"], r)) for r in partial["rows"]],
                        }

                elif node_name == "correct_sql":
                    yield {"stage": "sql", "sql": partial["sql"]}

                elif node_name == "decide_chart":
                    yield {"stage": "chart", "chart": partial["chart"]}

                elif node_name == "narrate":
                    yield {"stage": "narration", "narration": partial["narration"]}
    except Exception as e:
        # Real bug, found live: an unhandled exception anywhere in here
        # (e.g. Gemini rate-limited AND the Ollama fallback also down —
        # httpx.ConnectError) used to propagate straight out of this
        # generator. FastAPI's StreamingResponse has no way to recover from
        # that mid-stream — it just cuts the HTTP connection, and the
        # frontend's fetch reader hangs forever waiting for a chunk that
        # will never arrive, since no terminal event was ever sent. The
        # docstring already claimed "always ends with clarification, error,
        # or done" — this is what actually makes that true instead of just
        # true in the cases that happened to get tested.
        # Full exception (with the actual httpx/Gemini/Ollama internals)
        # goes to the server log for debugging — the user gets a plain
        # message, not a raw stack-trace-adjacent string like "Client
        # error '404 Not Found' for url 'http://localhost:11434/...'".
        logger.exception("ask_stream failed unexpectedly")
        yield {
            "stage": "error",
            "question": question,
            "error": "Something went wrong answering that — please try again in a moment.",
        }
        return

    final = app.get_state(config).values
    yield {
        "stage": "done",
        "question": question,
        "sql": final.get("sql"),
        "columns": final.get("columns"),
        "rows": [dict(zip(final["columns"], r)) for r in final["rows"]] if final.get("rows") else [],
        "chart": final.get("chart"),
        "narration": final.get("narration"),
    }
