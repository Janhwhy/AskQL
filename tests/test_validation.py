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
    sql = "SELECT id FROM a UNION SELECT id FROM b"
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
