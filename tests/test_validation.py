"""Tests for agent/validation.py — CLAUDE.md conventions: "SQL validation
must be covered" at minimum, and constraint 3 calls this the PRIMARY
guardrail (DuckDB has no role-based permissions to fall back on).
"""

import pytest

from agent.validation import UnsafeSQLError, validate_select_only


def test_plain_select_passes():
    sql = "SELECT * FROM customers"
    assert validate_select_only(sql) == sql


def test_select_with_join_and_group_by_passes():
    sql = "SELECT region, SUM(amount) FROM sales JOIN customers USING (customer_id) GROUP BY region"
    assert validate_select_only(sql) == sql


def test_union_of_selects_passes():
    sql = "SELECT customer_id FROM sales UNION SELECT customer_id FROM support_tickets"
    assert validate_select_only(sql) == sql


@pytest.mark.parametrize(
    "sql",
    [
        "DELETE FROM customers",
        "DROP TABLE customers",
        "INSERT INTO customers VALUES (1, 'x')",
        "UPDATE customers SET name = 'x'",
        "ALTER TABLE customers ADD COLUMN x INT",
        "TRUNCATE TABLE customers",
        "ATTACH 'evil.db' AS evil",
        "CREATE TABLE x (id INT)",
    ],
)
def test_non_select_statements_rejected(sql):
    with pytest.raises(UnsafeSQLError):
        validate_select_only(sql)


def test_delete_hidden_inside_a_subquery_is_still_rejected():
    """The exact case the code comment calls out — a non-SELECT nested
    inside what looks like a SELECT at the top level."""
    sql = "SELECT * FROM (DELETE FROM customers RETURNING *)"
    with pytest.raises(UnsafeSQLError):
        validate_select_only(sql)


def test_multiple_statements_rejected():
    with pytest.raises(UnsafeSQLError):
        validate_select_only("SELECT * FROM customers; DROP TABLE customers")


def test_unparseable_sql_rejected():
    with pytest.raises(UnsafeSQLError):
        validate_select_only("this is not sql at all !!!")


def test_cte_names_are_allowed():
    sql = "WITH daily AS (SELECT date, SUM(amount) AS r FROM sales GROUP BY date) SELECT * FROM daily"
    assert validate_select_only(sql) == sql


@pytest.mark.parametrize(
    "sql",
    [
        # Table functions and quoted paths are SELECTs that read arbitrary files.
        "SELECT * FROM read_text('/etc/hosts')",
        "SELECT * FROM read_csv_auto('.env')",
        "SELECT * FROM 'data/askql.db'",
        "SELECT * FROM duckdb_settings()",
        "SELECT * FROM sales JOIN read_text('/etc/hosts') ON true",
        "SELECT * FROM (SELECT * FROM read_text('/etc/hosts'))",
        # Anything outside the governed tables, including other catalogs.
        "SELECT * FROM information_schema.tables",
        "SELECT * FROM other_db.main.sales",
        "SELECT * FROM secrets",
    ],
)
def test_non_governed_sources_rejected(sql):
    with pytest.raises(UnsafeSQLError):
        validate_select_only(sql)


def test_every_metric_source_and_join_is_allowed():
    """Keeps ALLOWED_TABLES in sync with metrics/*.yaml: a new metric over a
    new table must fail here, not silently get every query rejected."""
    from metrics.loader import load_metrics

    for m in load_metrics().values():
        sql = f"SELECT 1 FROM {m.source} {m.join or ''}"
        validate_select_only(sql)
