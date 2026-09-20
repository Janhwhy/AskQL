"""Shared DuckDB connection + schema for the simulated-company data model.

Single writer, single file — see CLAUDE.md constraint 1. Every module in
`ingestion/` takes a connection rather than opening its own.

2026-09-20: schema rebuilt for the fully-synthetic company pivot (see
ingestion/company.py). Region/channel are never duplicated onto fact rows —
always joined through `customers` at query time, same as an analyst would,
just live instead of a weekly manual pivot.
"""

from pathlib import Path

import duckdb

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "askql.db"

SCHEMA_STATEMENTS = [
    """CREATE TABLE IF NOT EXISTS products (
        product_id INTEGER PRIMARY KEY, name TEXT, category TEXT,
        price DOUBLE, base_daily_sales DOUBLE, growth_rate DOUBLE
    )""",
    """CREATE TABLE IF NOT EXISTS sales_reps (
        rep_id INTEGER PRIMARY KEY, name TEXT, region TEXT
    )""",
    """CREATE TABLE IF NOT EXISTS customers (
        customer_id INTEGER PRIMARY KEY, name TEXT, region TEXT,
        plan_tier TEXT, rep_id INTEGER, signed_up_at DATE, churned_at DATE
    )""",
    """CREATE TABLE IF NOT EXISTS sales (
        sale_id BIGINT PRIMARY KEY, date DATE, product_id INTEGER,
        customer_id INTEGER, channel TEXT, quantity INTEGER, amount DOUBLE
    )""",
    """CREATE TABLE IF NOT EXISTS support_tickets (
        ticket_id BIGINT PRIMARY KEY, date DATE, product_id INTEGER,
        customer_id INTEGER, opened_at DATE, closed_at DATE, status TEXT
    )""",
]


def get_connection(read_only: bool = False) -> duckdb.DuckDBPyConnection:
    """read_only=True for the agent (askql-project-spec.md guardrails: "agent
    connects read-only" as a second line of defense behind sqlglot). Only
    works when no writer connection is open on the same file at that moment
    — fine here since the daily generator job runs briefly and exits, it
    doesn't hold the file open."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    if read_only:
        return duckdb.connect(str(DB_PATH), read_only=True)
    con = duckdb.connect(str(DB_PATH))
    for statement in SCHEMA_STATEMENTS:
        con.execute(statement)
    return con
