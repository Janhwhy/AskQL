"""Chart-type decision — CLAUDE.md constraint 4: the LLM never generates
images, it outputs structured {chart_type, x, y, series} JSON. Deliberately a
pure function, no LLM judgment call — no network round-trip, deterministic,
testable with hand-built fixtures, keeps the latency budget (constraint 6)
intact.

That determinism had a real gap, found from a live bug report: it only ever
looked at the query RESULT SHAPE, never at what the user actually asked for
— so "pie chart for revenue by region" silently got a bar chart instead,
not because the shape was ambiguous, but because chart type never read the
question at all. Fixed by checking for an explicit request first (still a
pure function, still no LLM call — just keyword matching against the
question text) and only falling back to shape-based inference when the
question doesn't say.
"""

import re
from datetime import date, datetime
from typing import Optional, TypedDict


class ChartDecision(TypedDict):
    chart_type: str  # "kpi" | "line" | "bar" | "pie" | "table"
    x: Optional[str]
    y: Optional[str]
    series: Optional[str]


def _is_time_value(v) -> bool:
    return isinstance(v, (date, datetime))


# Order matters only in that the first match wins if a question somehow
# names two chart types — real phrasing doesn't usually do that.
_CHART_TYPE_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("pie", re.compile(r"\bpie\s*(chart|graph)?\b")),
    ("line", re.compile(r"\b(line\s*(chart|graph)|trend\s*(line|chart))\b")),
    ("bar", re.compile(r"\bbar\s*(chart|graph)\b")),
    ("table", re.compile(r"\b(as a table|table view|raw (data|rows|table)|in a table)\b")),
    ("kpi", re.compile(r"\b(single number|just the (total|number)|one number)\b")),
]


def _requested_chart_type(question: str) -> Optional[str]:
    q = (question or "").lower()
    for chart_type, pattern in _CHART_TYPE_PATTERNS:
        if pattern.search(q):
            return chart_type
    return None


def _column_types(columns: list[str], first_row: tuple) -> tuple[list[int], list[int], Optional[int]]:
    """Splits column indices into (numeric, categorical, time) by the first
    row's actual value types — shared by every branch below so "numeric"
    and "categorical" mean the same thing everywhere, instead of each
    branch re-deriving it slightly differently (that drift is exactly what
    caused the two-categorical-columns bar bug)."""
    time_idx = next((i for i, v in enumerate(first_row) if _is_time_value(v)), None)
    numeric_idx = [
        i for i, v in enumerate(first_row) if isinstance(v, (int, float)) and i != time_idx
    ]
    categorical_idx = [
        i for i in range(len(columns)) if i != time_idx and i not in numeric_idx
    ]
    return numeric_idx, categorical_idx, time_idx


def decide_chart(columns: list[str], rows: list[tuple], question: str = "") -> ChartDecision:
    if not rows or not columns:
        return {"chart_type": "table", "x": None, "y": None, "series": None}

    first_row = rows[0]
    numeric_idx, categorical_idx, time_idx = _column_types(columns, first_row)
    requested = _requested_chart_type(question)

    if requested == "table":
        return {"chart_type": "table", "x": None, "y": None, "series": None}

    if requested == "kpi" and numeric_idx:
        return {"chart_type": "kpi", "x": None, "y": columns[numeric_idx[0]], "series": None}

    if requested == "pie" and numeric_idx and categorical_idx:
        return {
            "chart_type": "pie",
            "x": columns[categorical_idx[0]],
            "y": columns[numeric_idx[0]],
            "series": None,
        }

    if requested == "line" and numeric_idx and (time_idx is not None or categorical_idx):
        x_idx = time_idx if time_idx is not None else categorical_idx[0]
        remaining_categorical = [i for i in categorical_idx if i != x_idx]
        return {
            "chart_type": "line",
            "x": columns[x_idx],
            "y": columns[numeric_idx[0]],
            "series": columns[remaining_categorical[0]] if remaining_categorical else None,
        }

    if requested == "bar" and numeric_idx and categorical_idx:
        remaining_categorical = categorical_idx[1:]
        return {
            "chart_type": "bar",
            "x": columns[categorical_idx[0]],
            "y": columns[numeric_idx[0]],
            "series": columns[remaining_categorical[0]] if remaining_categorical else None,
        }

    # No explicit request, or the request didn't fit this result's actual
    # shape (e.g. "pie chart" over a single total with no categories to
    # slice) — fall back to inferring from the shape itself.

    if len(rows) == 1 and len(columns) == 1:
        return {"chart_type": "kpi", "x": None, "y": columns[0], "series": None}

    if time_idx is not None:
        other_idx = [i for i in range(len(columns)) if i != time_idx]
        if not other_idx:
            return {"chart_type": "line", "x": columns[time_idx], "y": None, "series": None}
        num_idx = next((i for i in other_idx if i in numeric_idx), other_idx[0])
        series_idx = next((i for i in other_idx if i != num_idx), None)
        return {
            "chart_type": "line",
            "x": columns[time_idx],
            "y": columns[num_idx],
            "series": columns[series_idx] if series_idx is not None else None,
        }

    if len(columns) >= 2:
        if not numeric_idx or not categorical_idx:
            return {"chart_type": "table", "x": None, "y": None, "series": None}
        return {
            "chart_type": "bar",
            "x": columns[categorical_idx[0]],
            "y": columns[numeric_idx[0]],
            "series": columns[categorical_idx[1]] if len(categorical_idx) > 1 else None,
        }

    return {"chart_type": "table", "x": None, "y": None, "series": None}
