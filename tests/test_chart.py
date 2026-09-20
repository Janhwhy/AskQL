"""Unit tests for agent/chart.py's decide_chart — pure function, no LLM or
DB involved, per CLAUDE.md: chart decision comes "from result shape."
"""

from datetime import date

from agent.chart import decide_chart


def test_single_row_single_column_is_kpi():
    result = decide_chart(["value"], [(698,)])
    assert result == {"chart_type": "kpi", "x": None, "y": "value", "series": None}


def test_time_column_is_line():
    rows = [(date(2026, 9, 18), 100.0), (date(2026, 9, 19), 120.0)]
    result = decide_chart(["day", "revenue"], rows)
    assert result["chart_type"] == "line"
    assert result["x"] == "day"
    assert result["y"] == "revenue"
    assert result["series"] is None


def test_time_plus_dimension_is_line_with_series():
    rows = [(date(2026, 9, 18), "EMEA", 100.0), (date(2026, 9, 18), "APAC", 80.0)]
    result = decide_chart(["day", "region", "revenue"], rows)
    # y must land on the NUMERIC column and series on the categorical one,
    # regardless of column order in the SQL result — a loose set() check
    # here previously hid a real y/series inversion bug.
    assert result == {"chart_type": "line", "x": "day", "y": "revenue", "series": "region"}


def test_time_plus_dimension_column_order_reversed_still_correct():
    """Same shape as above but with region/revenue swapped in column order —
    catches the exact bug a positional (not type-based) y/series pick would
    reintroduce."""
    rows = [(date(2026, 9, 18), 100.0, "EMEA"), (date(2026, 9, 18), 80.0, "APAC")]
    result = decide_chart(["day", "revenue", "region"], rows)
    assert result == {"chart_type": "line", "x": "day", "y": "revenue", "series": "region"}


def test_categorical_no_time_is_bar():
    rows = [("EMEA", 100.0), ("APAC", 80.0)]
    result = decide_chart(["region", "revenue"], rows)
    assert result == {"chart_type": "bar", "x": "region", "y": "revenue", "series": None}


def test_empty_rows_is_table_fallback():
    assert decide_chart(["day", "value"], [])["chart_type"] == "table"


def test_all_numeric_multi_column_no_category_is_table_fallback():
    result = decide_chart(["a", "b"], [(1, 2), (3, 4)])
    assert result["chart_type"] == "table"
