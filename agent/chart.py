"""Chart-type decision — CLAUDE.md constraint 4: the LLM never generates
images, it outputs structured {chart_type, x, y, series} JSON. This is a pure
function of the query RESULT SHAPE ("chart decision ... from result shape"),
not an LLM judgment call — no network round-trip, deterministic, testable
with hand-built fixtures, keeps the latency budget (constraint 6) intact.
"""

from datetime import date, datetime
from typing import Optional, TypedDict


class ChartDecision(TypedDict):
    chart_type: str  # "kpi" | "line" | "bar" | "table"
    x: Optional[str]
    y: Optional[str]
    series: Optional[str]


def _is_time_value(v) -> bool:
    return isinstance(v, (date, datetime))


def decide_chart(columns: list[str], rows: list[tuple]) -> ChartDecision:
    if not rows or not columns:
        return {"chart_type": "table", "x": None, "y": None, "series": None}

    if len(rows) == 1 and len(columns) == 1:
        return {"chart_type": "kpi", "x": None, "y": columns[0], "series": None}

    first_row = rows[0]
    time_idx = next((i for i, v in enumerate(first_row) if _is_time_value(v)), None)

    if time_idx is not None:
        other_idx = [i for i in range(len(columns)) if i != time_idx]
        x = columns[time_idx]
        y = columns[other_idx[0]] if other_idx else None
        series = columns[other_idx[1]] if len(other_idx) > 1 else None
        return {"chart_type": "line", "x": x, "y": y, "series": series}

    if len(columns) >= 2:
        # First non-numeric-looking column is the category axis; if none of
        # them look numeric (edge case), fall back to a plain table rather
        # than guessing which is which.
        cat_idx = next(
            (i for i, v in enumerate(first_row) if not isinstance(v, (int, float))), None
        )
        if cat_idx is None:
            return {"chart_type": "table", "x": None, "y": None, "series": None}
        num_idx = [i for i in range(len(columns)) if i != cat_idx]
        x = columns[cat_idx]
        y = columns[num_idx[0]] if num_idx else None
        series = columns[num_idx[1]] if len(num_idx) > 1 else None
        return {"chart_type": "bar", "x": x, "y": y, "series": series}

    return {"chart_type": "table", "x": None, "y": None, "series": None}
