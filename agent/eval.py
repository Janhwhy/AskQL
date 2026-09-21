"""Golden eval harness — runs a fixed set of realistic questions against the
REAL agent (real LLM calls, real DuckDB queries — nothing mocked) and asserts
STRUCTURAL properties of the result: which columns/keywords the SQL must (or
must not) contain, which chart type came out, whether a refusal/ambiguity
was correctly triggered, and — for multi-turn cases — whether a follow-up
correctly reused or correctly extended the prior turn.

Why this exists: every bug fixed in this project so far (see CLAUDE.md's
Phase 3-5 writeups) was found by a human eyeballing a live screenshot, one at
a time, AFTER it shipped — `tests/test_agent_graph.py` mocks `generate()`, so
it only proves the LangGraph WIRING is correct, never that the LLM actually
writes the right SQL for a given English question. This harness closes that
gap: it's the same class of check as `agent/cli.py` (Phase 3's "ask ten
questions, the failures define the next phase"), but with actual pass/fail
assertions instead of a human reading JSON, and covering the multi-turn
conversational-memory features (Phase 4/5) `cli.py` never exercised.

Assertions are deliberately LOOSE on exact wording (substring checks, not
exact-SQL-string matches) — an LLM's phrasing varies run to run even at
temperature-adjacent settings, and the point is to catch a wrong METRIC, a
wrong TABLE, a wrong DATE RANGE, or a wrong CHART TYPE, not to pin down
byte-identical SQL.

Run:
    python -m agent.eval

Exits 1 if any case failed, 0 if all passed — usable as a (slow, real-LLM,
real-API-cost) CI gate, not just an interactive check.
"""

import sys
import uuid
from dataclasses import dataclass, field
from typing import Callable, Optional

from dotenv import load_dotenv

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

load_dotenv()

from .graph import ask  # noqa: E402  (after load_dotenv, needs GEMINI_API_KEY present)

Check = Callable[[dict, list], list]


def _lower(s) -> str:
    return (s or "").lower()


def sql_contains(*needles: str) -> Check:
    def check(r: dict, history: list) -> list[str]:
        sql = _lower(r.get("sql"))
        return [f"SQL missing {n!r} -- got: {r.get('sql')!r}" for n in needles if n.lower() not in sql]

    return check


def sql_not_contains(*needles: str) -> Check:
    def check(r: dict, history: list) -> list[str]:
        sql = _lower(r.get("sql"))
        return [f"SQL must not contain {n!r} -- got: {r.get('sql')!r}" for n in needles if n.lower() in sql]

    return check


def has_rows() -> Check:
    def check(r: dict, history: list) -> list[str]:
        return [] if "rows" in r and r.get("error") is None else [f"expected successful rows, got: {r}"]

    return check


def is_ambiguous(min_candidates: int = 2) -> Check:
    def check(r: dict, history: list) -> list[str]:
        if "clarification_needed" not in r:
            return [f"expected an ambiguity clarification, got: {r}"]
        n = len(r.get("candidates") or [])
        return [] if n >= min_candidates else [f"expected >= {min_candidates} candidates, got {r.get('candidates')}"]

    return check


def is_refused() -> Check:
    def check(r: dict, history: list) -> list[str]:
        if r.get("sql") is not None or "rows" in r or "clarification_needed" in r:
            return [f"expected a NO_METRIC refusal (sql=None, no rows), got: {r}"]
        if not r.get("error"):
            return [f"expected a refusal reason in 'error', got: {r}"]
        return []

    return check


def chart_type_is(expected: str) -> Check:
    def check(r: dict, history: list) -> list[str]:
        actual = (r.get("chart") or {}).get("chart_type")
        return [] if actual == expected else [f"expected chart_type={expected!r}, got {actual!r}"]

    return check


def sql_same_as_previous_turn() -> Check:
    def check(r: dict, history: list) -> list[str]:
        if not history:
            return ["no previous turn in this case to compare against"]
        prev_sql = history[-1].get("sql")
        return (
            []
            if r.get("sql") == prev_sql
            else [f"expected SQL to be reused unchanged from the prior turn ({prev_sql!r}), got {r.get('sql')!r}"]
        )

    return check


def combine(*checks: Check) -> Check:
    def check(r: dict, history: list) -> list[str]:
        issues = []
        for c in checks:
            issues += c(r, history)
        return issues

    return check


@dataclass
class Turn:
    question: Optional[str]
    clarification_answer: Optional[str] = None
    check: Optional[Check] = None
    label: str = ""

    def display(self) -> str:
        return self.label or self.question or f"(clarify: {self.clarification_answer!r})"


@dataclass
class Case:
    id: str
    turns: list = field(default_factory=list)


CASES: list[Case] = [
    Case("revenue-yesterday", [
        Turn("What was total revenue yesterday?", check=combine(has_rows(), sql_contains("amount", "interval 1 day"))),
    ]),
    Case("new-customers-7d", [
        Turn(
            "How many new customers signed up in the last 7 days?",
            check=combine(has_rows(), sql_contains("signed_up_at", "interval 7 day")),
        ),
    ]),
    Case("support-backlog", [
        Turn(
            "What's the support ticket backlog right now?",
            check=combine(has_rows(), sql_contains("support_tickets", "'open'")),
        ),
    ]),
    Case("revenue-by-region-30d", [
        Turn(
            "Show revenue by region for the last 30 days.",
            check=combine(has_rows(), sql_contains("amount", "region", "interval 30 day")),
        ),
    ]),
    Case("churned-total-no-date", [
        Turn(
            "How many customers have churned in total?",
            check=combine(has_rows(), sql_contains("churned_at", "not null"), sql_not_contains("interval")),
        ),
    ]),
    Case("avg-deal-size-month", [
        Turn(
            "What's the average deal size this month?",
            check=combine(has_rows(), sql_contains("amount", "avg(")),
        ),
    ]),
    Case("tickets-by-category-30d", [
        Turn(
            "Break down support tickets opened by product category, last 30 days.",
            check=combine(has_rows(), sql_contains("support_tickets", "category", "interval 30 day")),
        ),
    ]),
    Case("avg-resolution-time", [
        Turn(
            "What's the average resolution time for support tickets?",
            check=combine(has_rows(), sql_contains("date_diff", "opened_at", "closed_at")),
        ),
    ]),
    Case("active-customers-by-tier", [
        Turn(
            "How many active customers do we have right now, by plan tier?",
            check=combine(has_rows(), sql_contains("churned_at", "plan_tier")),
        ),
    ]),
    Case("daily-revenue-14d-line", [
        Turn(
            "Show me daily revenue for the last 14 days.",
            check=combine(has_rows(), sql_contains("amount", "interval 14 day"), chart_type_is("line")),
        ),
    ]),
    Case("ambiguous-support", [
        Turn("How's support doing?", check=is_ambiguous()),
    ]),
    Case("ambiguous-customers", [
        Turn("Tell me about our customers.", check=is_ambiguous()),
    ]),
    Case("out-of-scope-weather", [
        Turn("What's the weather like today?", check=is_refused()),
    ]),
    Case("explicit-pie-request", [
        Turn(
            "Give me a pie chart for revenue by region.",
            check=combine(has_rows(), chart_type_is("pie")),
        ),
    ]),
    Case("explicit-table-request", [
        Turn(
            "Show support tickets opened by product category as a table.",
            check=combine(has_rows(), chart_type_is("table")),
        ),
    ]),
    Case("units-sold-metric-name-trap", [
        # Real bug this guards against: the LLM wrote SUM(units_sold) --
        # "units_sold" is the metric's NAME, not a real column; the actual
        # SQL expression is `quantity`. See CLAUDE.md Phase 5's
        # "Continuation questions" writeup.
        Turn(
            "How many units have we sold in total?",
            check=combine(has_rows(), sql_contains("quantity"), sql_not_contains("units_sold")),
        ),
    ]),
    Case("churn-rate", [
        Turn(
            "What's our churn rate?",
            check=combine(has_rows(), sql_contains("case", "when", "churned_at")),
        ),
    ]),
    Case("continuation-same-metric-new-range", [
        # Real bug this guards against: "now the same for 7 days" used to
        # drift to a completely unrelated metric because generate_sql had
        # no memory of the prior turn outside the narrow chart-followup
        # path. See CLAUDE.md Phase 5's "Continuation questions" writeup.
        Turn(
            "Show me daily revenue for the last 14 days.",
            check=combine(has_rows(), sql_contains("amount", "interval 14 day")),
        ),
        Turn(
            "now the same for 7 days",
            check=combine(has_rows(), sql_contains("amount", "interval 7 day"), sql_not_contains("units_sold")),
        ),
    ]),
    Case("chart-followup-reuses-prior-data", [
        Turn(
            "Revenue by region as a pie chart.",
            check=combine(has_rows(), chart_type_is("pie")),
        ),
        Turn(
            "now give it as a table",
            check=combine(has_rows(), chart_type_is("table"), sql_same_as_previous_turn()),
        ),
    ]),
    Case("ambiguity-round-trip-resolves", [
        Turn("How's support doing?", check=is_ambiguous()),
        Turn(
            None,
            clarification_answer="tickets opened",
            # support_tickets_opened has no base filter/expression (unlike
            # its siblings: _resolved and _backlog both filter on `status`,
            # avg_resolution_time uses `date_diff`) -- that absence is what
            # proves this resolved to "opened" specifically. No date range
            # was asked for, so the SQL correctly won't mention opened_at
            # at all (rule 2: an unrequested date filter must be omitted).
            check=combine(has_rows(), sql_contains("support_tickets"), sql_not_contains("status", "date_diff")),
        ),
    ]),
]


def run_case(case: Case) -> tuple[bool, list[str]]:
    thread_id = f"eval-{case.id}-{uuid.uuid4().hex[:8]}"
    history: list[dict] = []
    issues: list[str] = []
    for i, turn in enumerate(case.turns, 1):
        try:
            result = ask(turn.question, thread_id=thread_id, clarification_answer=turn.clarification_answer)
        except Exception as e:
            issues.append(f"turn {i} ({turn.display()}): unhandled exception: {e}")
            break
        turn_issues = turn.check(result, history) if turn.check else []
        for issue in turn_issues:
            issues.append(f"turn {i} ({turn.display()}): {issue}")
        history.append(result)
    return (len(issues) == 0, issues)


def main() -> None:
    results = []
    for case in CASES:
        ok, issues = run_case(case)
        results.append((case.id, ok))
        print(f"[{'PASS' if ok else 'FAIL'}] {case.id}")
        for issue in issues:
            print(f"    - {issue}")

    n_ok = sum(1 for _, ok in results if ok)
    print(f"\n{'=' * 60}\n{n_ok}/{len(results)} cases passed")
    if n_ok != len(results):
        sys.exit(1)


if __name__ == "__main__":
    main()
