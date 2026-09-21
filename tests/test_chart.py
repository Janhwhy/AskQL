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


def test_two_categorical_dimensions_one_metric_is_bar_with_series():
    """Real bug, caught from a live screenshot: "best selling products AND
    their category" returns columns [name, category, units_sold] -- both
    name and category are non-numeric. The old logic treated "everything
    after the first categorical column" as numeric, so it put the category
    STRING on the numeric y-axis (no bars could render at all) and turned
    units_sold into a fake per-value legend series. y must land on the one
    actually-numeric column regardless of how many categorical columns
    precede it."""
    rows = [("DocSpace", "Collaboration & Productivity", 8305), ("TaskRiver", "Collaboration & Productivity", 7200)]
    result = decide_chart(["name", "category", "units_sold"], rows)
    assert result == {"chart_type": "bar", "x": "name", "y": "units_sold", "series": "category"}


def test_empty_rows_is_table_fallback():
    assert decide_chart(["day", "value"], [])["chart_type"] == "table"


def test_all_numeric_multi_column_no_category_is_table_fallback():
    result = decide_chart(["a", "b"], [(1, 2), (3, 4)])
    assert result["chart_type"] == "table"


# --- explicit chart-type requests (real bug: "pie chart for revenue by
# region" silently returned a bar chart, because chart type never read the
# question at all — this class of test is what would have caught it) ---


def test_explicit_pie_request_overrides_shape_inference():
    rows = [("EMEA", 100.0), ("APAC", 80.0)]
    result = decide_chart(["region", "revenue"], rows, question="pie chart for revenue by region")
    assert result == {"chart_type": "pie", "x": "region", "y": "revenue", "series": None}


def test_explicit_pie_request_various_phrasings():
    rows = [("EMEA", 100.0), ("APAC", 80.0)]
    for phrasing in ["show this as a pie", "give me a pie graph", "PIE CHART please"]:
        result = decide_chart(["region", "revenue"], rows, question=phrasing)
        assert result["chart_type"] == "pie", phrasing


def test_explicit_bar_request_overrides_line_inference():
    """Same time+dimension shape that would normally become a line chart —
    an explicit "bar chart" ask should win."""
    rows = [(date(2026, 9, 18), "EMEA", 100.0), (date(2026, 9, 18), "APAC", 80.0)]
    result = decide_chart(["day", "region", "revenue"], rows, question="bar chart of revenue by region")
    assert result["chart_type"] == "bar"


def test_explicit_table_request_overrides_everything():
    rows = [("EMEA", 100.0), ("APAC", 80.0)]
    result = decide_chart(["region", "revenue"], rows, question="show me this as a table")
    assert result == {"chart_type": "table", "x": None, "y": None, "series": None}


def test_bare_word_table_request_is_recognized():
    """Real bug, caught live: "table of top 10 products" got a bar chart --
    the old regex only matched fixed phrases ("as a table", "table view")
    and never the bare word "table" by itself, unlike every other chart
    type's pattern (pie/line/bar all match on their single keyword)."""
    rows = [("Widget", 100.0), ("Gadget", 80.0)]
    for phrasing in ["table of top 10 products", "give me a table", "top products table"]:
        result = decide_chart(["product", "revenue"], rows, question=phrasing)
        assert result["chart_type"] == "table", phrasing


def test_pie_request_falls_back_when_shape_cant_support_it():
    """A single total has no categories to slice -- "pie chart of total
    revenue" should degrade to kpi, not force a meaningless one-slice pie."""
    result = decide_chart(["total_revenue"], [(50000.0,)], question="pie chart of total revenue")
    assert result["chart_type"] == "kpi"


def test_no_explicit_request_still_infers_from_shape():
    """Unchanged default behavior when the question doesn't name a chart type."""
    rows = [("EMEA", 100.0), ("APAC", 80.0)]
    result = decide_chart(["region", "revenue"], rows, question="revenue by region")
    assert result["chart_type"] == "bar"
