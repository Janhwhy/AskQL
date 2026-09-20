"""Shared DuckDB connection + schema for the ingestion layer.

Single writer, single file — see CLAUDE.md constraint 1. Every module in
`ingestion/` takes a connection rather than opening its own.
"""

from pathlib import Path

import duckdb

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "askql.db"

SCHEMA_STATEMENTS = [
    """CREATE TABLE IF NOT EXISTS repo_snapshots (
        repo TEXT, stars INT, open_issues INT, captured_at TIMESTAMP
    )""",
    """CREATE TABLE IF NOT EXISTS repo_events (
        event_id TEXT PRIMARY KEY,
        repo TEXT, event_type TEXT, actor TEXT,
        created_at TIMESTAMP, captured_at TIMESTAMP
    )""",
    """CREATE TABLE IF NOT EXISTS npm_downloads (
        package TEXT, downloads BIGINT,
        period_start DATE, period_end DATE, captured_at TIMESTAMP
    )""",
    """CREATE TABLE IF NOT EXISTS pypi_downloads (
        package TEXT, downloads BIGINT, day DATE, captured_at TIMESTAMP
    )""",
    """CREATE TABLE IF NOT EXISTS hn_mentions (
        query TEXT, story_id BIGINT, title TEXT,
        points INT, num_comments INT, story_created_at TIMESTAMP, captured_at TIMESTAMP
    )""",
    """CREATE TABLE IF NOT EXISTS star_history (
        repo TEXT, user TEXT, starred_at TIMESTAMP, captured_at TIMESTAMP,
        PRIMARY KEY (repo, user)
    )""",
    """CREATE TABLE IF NOT EXISTS issue_history (
        repo TEXT, issue_number BIGINT, state TEXT,
        created_at TIMESTAMP, closed_at TIMESTAMP, captured_at TIMESTAMP,
        PRIMARY KEY (repo, issue_number)
    )""",
    """CREATE TABLE IF NOT EXISTS pr_history (
        repo TEXT, pr_number BIGINT, state TEXT,
        created_at TIMESTAMP, merged_at TIMESTAMP, captured_at TIMESTAMP,
        PRIMARY KEY (repo, pr_number)
    )""",
    """CREATE TABLE IF NOT EXISTS http_cache (
        cache_key TEXT PRIMARY KEY, etag TEXT
    )""",
    """CREATE TABLE IF NOT EXISTS sales_reps (
        rep_id INTEGER PRIMARY KEY, name TEXT, region TEXT
    )""",
    """CREATE TABLE IF NOT EXISTS customers (
        customer_id INTEGER PRIMARY KEY, name TEXT, region TEXT,
        plan_tier TEXT, rep_id INTEGER, signed_up_at DATE
    )""",
]

# migration for dbs created before the `day` column existed on pypi_downloads.
# ADD COLUMN always appends at the end, so it changes physical column order on
# already-migrated DBs vs. a fresh CREATE TABLE — every INSERT into a migrated
# table MUST use an explicit column list, never positional VALUES.
MIGRATIONS = [
    "ALTER TABLE pypi_downloads ADD COLUMN IF NOT EXISTS day DATE",
]


def get_connection() -> duckdb.DuckDBPyConnection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(DB_PATH))
    for statement in SCHEMA_STATEMENTS:
        con.execute(statement)
    for statement in MIGRATIONS:
        con.execute(statement)
    return con


def get_etag(con: duckdb.DuckDBPyConnection, cache_key: str) -> str | None:
    row = con.execute(
        "SELECT etag FROM http_cache WHERE cache_key = ?", [cache_key]
    ).fetchone()
    return row[0] if row else None


def set_etag(con: duckdb.DuckDBPyConnection, cache_key: str, etag: str) -> None:
    con.execute(
        """INSERT INTO http_cache (cache_key, etag) VALUES (?, ?)
           ON CONFLICT (cache_key) DO UPDATE SET etag = excluded.etag""",
        [cache_key, etag],
    )
