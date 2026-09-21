"""Dashboard/layout persistence — deliberately a SEPARATE SQLite file
(`data/dashboards.sqlite3`), not a table inside `data/askql.db`.

CLAUDE.md constraint 1 is load-bearing: DuckDB allows one writer OR many
readers on a file, never both, and the daily poll job (Task Scheduler) and
this API must never contend for that single writer slot. Dashboard/layout
metadata is small, structural, and written on-demand by user clicks (pin a
chart, drag a tile) — putting it in `askql.db` would mean this API needs a
WRITE connection to the analytical file, which is exactly the two-writers
problem constraint 1 exists to avoid. SQLite has its own (uncontended, this
app is the only thing touching this file) locking and needs none of that
care, so it's the simpler and more correct choice here, not just a
workaround.

Uses the stdlib `sqlite3` module directly, same reasoning as the project's
existing "no SQLAlchemy" choice for DuckDB (CLAUDE.md's Stack table): no
server DB, no ORM needed for two small tables.
"""

import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator, Optional

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "dashboards.sqlite3"

SCHEMA_STATEMENTS = [
    """CREATE TABLE IF NOT EXISTS dashboards (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS dashboard_items (
        id TEXT PRIMARY KEY,
        dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
        question TEXT NOT NULL,
        sql TEXT NOT NULL,
        chart_type TEXT NOT NULL,
        chart_x TEXT,
        chart_y TEXT,
        chart_series TEXT,
        narration TEXT,
        layout_x INTEGER NOT NULL,
        layout_y INTEGER NOT NULL,
        layout_w INTEGER NOT NULL,
        layout_h INTEGER NOT NULL,
        created_at TEXT NOT NULL
    )""",
]

# 12-column grid (react-grid-layout default). A newly pinned tile gets half
# the row width and a fixed starting height -- the user can resize/rearrange
# from there, this is just a sane default so tiles don't all stack at 0,0.
DEFAULT_W = 6
DEFAULT_H = 8


@contextmanager
def _connection() -> Iterator[sqlite3.Connection]:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(DB_PATH))
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    try:
        for statement in SCHEMA_STATEMENTS:
            con.execute(statement)
        yield con
        con.commit()
    finally:
        con.close()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def create_dashboard(name: str) -> dict:
    with _connection() as con:
        row = {"id": uuid.uuid4().hex, "name": name, "created_at": _now()}
        con.execute(
            "INSERT INTO dashboards (id, name, created_at) VALUES (:id, :name, :created_at)",
            row,
        )
        return row


def list_dashboards() -> list[dict]:
    with _connection() as con:
        rows = con.execute(
            """SELECT d.id, d.name, d.created_at, COUNT(i.id) AS item_count
               FROM dashboards d LEFT JOIN dashboard_items i ON i.dashboard_id = d.id
               GROUP BY d.id ORDER BY d.created_at DESC"""
        ).fetchall()
        return [dict(r) for r in rows]


def get_dashboard(dashboard_id: str) -> Optional[dict]:
    with _connection() as con:
        dashboard = con.execute("SELECT * FROM dashboards WHERE id = ?", [dashboard_id]).fetchone()
        if dashboard is None:
            return None
        items = con.execute(
            "SELECT * FROM dashboard_items WHERE dashboard_id = ? ORDER BY created_at", [dashboard_id]
        ).fetchall()
        return {**dict(dashboard), "items": [dict(i) for i in items]}


def delete_dashboard(dashboard_id: str) -> bool:
    with _connection() as con:
        cur = con.execute("DELETE FROM dashboards WHERE id = ?", [dashboard_id])
        return cur.rowcount > 0


def add_item(
    dashboard_id: str,
    question: str,
    sql: str,
    chart_type: str,
    chart_x: Optional[str],
    chart_y: Optional[str],
    chart_series: Optional[str],
    narration: Optional[str],
) -> Optional[dict]:
    with _connection() as con:
        exists = con.execute("SELECT 1 FROM dashboards WHERE id = ?", [dashboard_id]).fetchone()
        if exists is None:
            return None
        # Stack new tiles below whatever's already there rather than
        # overlapping at (0, 0) -- next row down, full computed from the
        # tallest existing tile's bottom edge.
        bottom = con.execute(
            "SELECT COALESCE(MAX(layout_y + layout_h), 0) AS bottom FROM dashboard_items WHERE dashboard_id = ?",
            [dashboard_id],
        ).fetchone()["bottom"]
        row = {
            "id": uuid.uuid4().hex,
            "dashboard_id": dashboard_id,
            "question": question,
            "sql": sql,
            "chart_type": chart_type,
            "chart_x": chart_x,
            "chart_y": chart_y,
            "chart_series": chart_series,
            "narration": narration,
            "layout_x": 0,
            "layout_y": bottom,
            "layout_w": DEFAULT_W,
            "layout_h": DEFAULT_H,
            "created_at": _now(),
        }
        con.execute(
            """INSERT INTO dashboard_items
               (id, dashboard_id, question, sql, chart_type, chart_x, chart_y, chart_series,
                narration, layout_x, layout_y, layout_w, layout_h, created_at)
               VALUES (:id, :dashboard_id, :question, :sql, :chart_type, :chart_x, :chart_y,
                       :chart_series, :narration, :layout_x, :layout_y, :layout_w, :layout_h, :created_at)""",
            row,
        )
        return row


def delete_item(dashboard_id: str, item_id: str) -> bool:
    with _connection() as con:
        cur = con.execute(
            "DELETE FROM dashboard_items WHERE id = ? AND dashboard_id = ?", [item_id, dashboard_id]
        )
        return cur.rowcount > 0


def update_layout(dashboard_id: str, items: list[dict]) -> None:
    """`items` is a list of {id, x, y, w, h}. Silently skips any id that
    doesn't belong to this dashboard rather than raising -- a stale tile the
    client hasn't refreshed yet shouldn't fail the whole batch."""
    with _connection() as con:
        for item in items:
            con.execute(
                """UPDATE dashboard_items SET layout_x = ?, layout_y = ?, layout_w = ?, layout_h = ?
                   WHERE id = ? AND dashboard_id = ?""",
                [item["x"], item["y"], item["w"], item["h"], item["id"], dashboard_id],
            )
