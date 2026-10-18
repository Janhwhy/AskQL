"""SQL guardrail — CLAUDE.md constraint 3: all generated SQL passes sqlglot
validation before execution. SELECT only, reject anything else. Primary
guardrail, not a nice-to-have — DuckDB has no role-based permissions to fall
back on (the read-only connection in ingestion/db.py is the second line of
defense, this is the first).
"""

import sqlglot
from sqlglot import exp


class UnsafeSQLError(ValueError):
    pass


# The governed tables (ingestion/db.py's schema) — the only relations any
# metric in metrics/*.yaml reads. A SELECT is not automatically a safe read:
# DuckDB table functions (`read_text('/etc/hosts')`, `read_csv('.env')`,
# `duckdb_settings()`) and quoted file paths (`FROM 'x.csv'`) are SELECTs
# too, and would read arbitrary files from disk. So every FROM/JOIN target
# must be one of these names (or a CTE defined in the same query).
ALLOWED_TABLES = frozenset({"products", "sales_reps", "customers", "sales", "support_tickets"})


def validate_select_only(sql: str) -> str:
    """Raises UnsafeSQLError unless `sql` parses as exactly one plain SELECT
    statement. Returns the SQL unchanged on success (so this can sit inline
    in a call chain)."""
    try:
        statements = sqlglot.parse(sql, read="duckdb")
    except Exception as e:
        raise UnsafeSQLError(f"SQL failed to parse: {e}") from e

    statements = [s for s in statements if s is not None]
    if len(statements) != 1:
        raise UnsafeSQLError(f"expected exactly one statement, got {len(statements)}")

    stmt = statements[0]
    if not isinstance(stmt, exp.Query):
        # exp.Query covers SELECT and set operations (UNION/INTERSECT/EXCEPT)
        # built from SELECTs — anything outside that tree isn't a read.
        raise UnsafeSQLError(f"only SELECT is allowed, got {type(stmt).__name__}")

    # sqlglot parses a SELECT's subqueries as nested exp.Select nodes too, so
    # this also catches e.g. `SELECT * FROM (DELETE FROM x RETURNING *)` —
    # any non-SELECT statement type anywhere in the tree is rejected.
    forbidden = (exp.Insert, exp.Update, exp.Delete, exp.Drop, exp.Create,
                 exp.Alter, exp.TruncateTable, exp.Attach, exp.Command)
    for node in stmt.walk():
        if isinstance(node, forbidden):
            raise UnsafeSQLError(f"forbidden clause found: {type(node).__name__}")

    cte_names = {cte.alias_or_name.lower() for cte in stmt.find_all(exp.CTE)}
    for table in stmt.find_all(exp.Table):
        if not isinstance(table.this, exp.Identifier) or table.this.quoted:
            # A function call (read_text(...), generate_series(...)) or a
            # quoted string, which DuckDB treats as a file path.
            raise UnsafeSQLError(f"only governed tables may be queried, got {table.this.sql('duckdb')}")
        if table.catalog or (table.db and table.db.lower() != "main"):
            raise UnsafeSQLError(f"only governed tables may be queried, got {table.sql('duckdb')}")
        name = table.name.lower()
        if name not in ALLOWED_TABLES and name not in cte_names:
            raise UnsafeSQLError(f"unknown table: {table.name}")

    return sql
