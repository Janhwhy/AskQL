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
server DB, no ORM needed for a few small tables.

Phase 8b: a dashboard is a Power BI-style REPORT -- one or more fixed-size
pages, each a free-form canvas. Item layout is absolute page pixels
(x, y, w, h, z), no longer react-grid-layout's 12-column grid units.
"""

import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator, Optional

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "dashboards.sqlite3"

PAGE_W, PAGE_H = 1280, 720  # Power BI's default 16:9 report page
CHART_SIZE = (608, 336)
TEXT_SIZE = (608, 96)
PAGE_MARGIN = 24
GAP = 16

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
    """CREATE TABLE IF NOT EXISTS dashboard_pages (
        id TEXT PRIMARY KEY,
        dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        position INTEGER NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        background TEXT,
        created_at TEXT NOT NULL
    )""",
]

# Additive, idempotent migrations -- (table, column, DDL). Only ever ADD a
# column with a default, never rewrite a table, so an existing
# data/dashboards.sqlite3 upgrades in place with no data loss.
# `layout_units`: rows written before Phase 8b hold react-grid-layout GRID
# units; the column defaults to 'grid' so exactly those rows get converted
# to page pixels once (see _migrate_data), and every new row is written 'px'.
MIGRATIONS = [
    ("dashboards", "description", "ALTER TABLE dashboards ADD COLUMN description TEXT NOT NULL DEFAULT ''"),
    ("dashboard_items", "kind", "ALTER TABLE dashboard_items ADD COLUMN kind TEXT NOT NULL DEFAULT 'chart'"),
    ("dashboard_items", "config_json", "ALTER TABLE dashboard_items ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}'"),
    ("dashboard_items", "text", "ALTER TABLE dashboard_items ADD COLUMN text TEXT"),
    ("dashboard_items", "page_id", "ALTER TABLE dashboard_items ADD COLUMN page_id TEXT"),
    ("dashboard_items", "layout_z", "ALTER TABLE dashboard_items ADD COLUMN layout_z INTEGER NOT NULL DEFAULT 0"),
    ("dashboard_items", "layout_units", "ALTER TABLE dashboard_items ADD COLUMN layout_units TEXT NOT NULL DEFAULT 'grid'"),
]

# The old grid: 12 columns across, 30px rows + 18px gutter.
_GRID_COL = PAGE_W / 12
_GRID_ROW = 48


def _snap(v: float) -> int:
    return int(round(v / 8) * 8)


def _migrate_data(con: sqlite3.Connection) -> None:
    """Gives every pre-8b dashboard a first page and converts grid-unit
    layouts to page pixels. Every statement is a no-op once migrated."""
    for (dashboard_id,) in con.execute(
        "SELECT id FROM dashboards d WHERE NOT EXISTS (SELECT 1 FROM dashboard_pages p WHERE p.dashboard_id = d.id)"
    ).fetchall():
        con.execute(
            """INSERT INTO dashboard_pages (id, dashboard_id, name, position, width, height, background, created_at)
               VALUES (?, ?, 'Page 1', 0, ?, ?, NULL, ?)""",
            [uuid.uuid4().hex, dashboard_id, PAGE_W, PAGE_H, _now()],
        )
    con.execute(
        """UPDATE dashboard_items SET page_id = (
               SELECT p.id FROM dashboard_pages p WHERE p.dashboard_id = dashboard_items.dashboard_id
               ORDER BY p.position LIMIT 1)
           WHERE page_id IS NULL"""
    )
    legacy = con.execute(
        "SELECT id, page_id, layout_x, layout_y, layout_w, layout_h FROM dashboard_items WHERE layout_units = 'grid'"
    ).fetchall()
    for r in legacy:
        x = _snap(r["layout_x"] * _GRID_COL) + 16
        y = _snap(r["layout_y"] * _GRID_ROW) + 16
        w = max(160, _snap(r["layout_w"] * _GRID_COL) - 32)
        h = max(64, _snap(r["layout_h"] * _GRID_ROW) - 24)
        con.execute(
            """UPDATE dashboard_items SET layout_x = ?, layout_y = ?, layout_w = ?, layout_h = ?, layout_units = 'px'
               WHERE id = ?""",
            [x, y, min(w, PAGE_W - x), h, r["id"]],
        )
    if legacy:
        # A tall old grid can run past 720px -- grow those pages so nothing
        # that used to be visible ends up off the page.
        con.execute(
            """UPDATE dashboard_pages SET height = MAX(height, (
                   SELECT COALESCE(MAX(layout_y + layout_h), 0) + 24 FROM dashboard_items i
                   WHERE i.page_id = dashboard_pages.id))"""
        )


@contextmanager
def _connection() -> Iterator[sqlite3.Connection]:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(DB_PATH))
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    try:
        for statement in SCHEMA_STATEMENTS:
            con.execute(statement)
        for table, column, ddl in MIGRATIONS:
            existing = {r["name"] for r in con.execute(f"PRAGMA table_info({table})")}
            if column not in existing:
                con.execute(ddl)
        _migrate_data(con)
        yield con
        con.commit()
    finally:
        con.close()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _item_row(r: sqlite3.Row) -> dict:
    d = dict(r)
    d["config"] = json.loads(d.pop("config_json") or "{}")
    return d


# --- dashboards ---------------------------------------------------------


def create_dashboard(name: str) -> dict:
    with _connection() as con:
        row = {"id": uuid.uuid4().hex, "name": name, "description": "", "created_at": _now()}
        con.execute(
            "INSERT INTO dashboards (id, name, description, created_at) VALUES (:id, :name, :description, :created_at)",
            row,
        )
        _insert_page(con, row["id"], "Page 1", 0)
        return row


def list_dashboards() -> list[dict]:
    with _connection() as con:
        rows = con.execute(
            """SELECT d.id, d.name, d.description, d.created_at, COUNT(i.id) AS item_count
               FROM dashboards d LEFT JOIN dashboard_items i ON i.dashboard_id = d.id
               GROUP BY d.id ORDER BY d.created_at DESC"""
        ).fetchall()
        # The FIRST page's tile rectangles (no SQL, no data) -- enough for the
        # gallery to draw each report's cover page as a blueprint thumbnail.
        first_pages = {
            r["dashboard_id"]: r
            for r in con.execute("SELECT * FROM dashboard_pages ORDER BY position DESC").fetchall()
        }
        thumbs: dict[str, list[dict]] = {}
        for t in con.execute(
            "SELECT page_id, layout_x AS x, layout_y AS y, layout_w AS w, layout_h AS h, kind FROM dashboard_items"
        ):
            thumbs.setdefault(t["page_id"], []).append(
                {"x": t["x"], "y": t["y"], "w": t["w"], "h": t["h"], "kind": t["kind"]}
            )
        out = []
        for r in rows:
            page = first_pages.get(r["id"])
            out.append(
                {
                    **dict(r),
                    "thumb": thumbs.get(page["id"], []) if page else [],
                    "thumb_page": {"w": page["width"], "h": page["height"]} if page else {"w": PAGE_W, "h": PAGE_H},
                }
            )
        return out


def get_dashboard(dashboard_id: str) -> Optional[dict]:
    with _connection() as con:
        dashboard = con.execute("SELECT * FROM dashboards WHERE id = ?", [dashboard_id]).fetchone()
        if dashboard is None:
            return None
        pages = con.execute(
            "SELECT * FROM dashboard_pages WHERE dashboard_id = ? ORDER BY position", [dashboard_id]
        ).fetchall()
        items = con.execute(
            "SELECT * FROM dashboard_items WHERE dashboard_id = ? ORDER BY layout_z, created_at", [dashboard_id]
        ).fetchall()
        return {**dict(dashboard), "pages": [dict(p) for p in pages], "items": [_item_row(i) for i in items]}


def update_dashboard(dashboard_id: str, name: Optional[str] = None, description: Optional[str] = None) -> bool:
    with _connection() as con:
        if con.execute("SELECT 1 FROM dashboards WHERE id = ?", [dashboard_id]).fetchone() is None:
            return False
        if name is not None:
            con.execute("UPDATE dashboards SET name = ? WHERE id = ?", [name, dashboard_id])
        if description is not None:
            con.execute("UPDATE dashboards SET description = ? WHERE id = ?", [description, dashboard_id])
        return True


def delete_dashboard(dashboard_id: str) -> bool:
    with _connection() as con:
        cur = con.execute("DELETE FROM dashboards WHERE id = ?", [dashboard_id])
        return cur.rowcount > 0


# --- pages --------------------------------------------------------------


def _insert_page(con: sqlite3.Connection, dashboard_id: str, name: str, position: int) -> dict:
    row = {
        "id": uuid.uuid4().hex,
        "dashboard_id": dashboard_id,
        "name": name,
        "position": position,
        "width": PAGE_W,
        "height": PAGE_H,
        "background": None,
        "created_at": _now(),
    }
    con.execute(
        """INSERT INTO dashboard_pages (id, dashboard_id, name, position, width, height, background, created_at)
           VALUES (:id, :dashboard_id, :name, :position, :width, :height, :background, :created_at)""",
        row,
    )
    return row


def add_page(dashboard_id: str, name: Optional[str] = None) -> Optional[dict]:
    with _connection() as con:
        if con.execute("SELECT 1 FROM dashboards WHERE id = ?", [dashboard_id]).fetchone() is None:
            return None
        n = con.execute("SELECT COUNT(*) FROM dashboard_pages WHERE dashboard_id = ?", [dashboard_id]).fetchone()[0]
        return _insert_page(con, dashboard_id, name or f"Page {n + 1}", n)


def get_page(dashboard_id: str, page_id: str) -> Optional[dict]:
    with _connection() as con:
        r = con.execute(
            "SELECT * FROM dashboard_pages WHERE id = ? AND dashboard_id = ?", [page_id, dashboard_id]
        ).fetchone()
        return dict(r) if r else None


def update_page(dashboard_id: str, page_id: str, fields: dict) -> Optional[dict]:
    """`fields` may hold name / width / height / background. `background`
    is set even when None (None = theme default), so callers pass only the
    keys they mean to change."""
    allowed = {k: v for k, v in fields.items() if k in {"name", "width", "height", "background"}}
    with _connection() as con:
        for k, v in allowed.items():
            con.execute(
                f"UPDATE dashboard_pages SET {k} = ? WHERE id = ? AND dashboard_id = ?", [v, page_id, dashboard_id]
            )
    return get_page(dashboard_id, page_id)


def delete_page(dashboard_id: str, page_id: str) -> str:
    """Returns 'deleted', 'missing', or 'last' (a report always keeps one page)."""
    with _connection() as con:
        pages = con.execute(
            "SELECT id FROM dashboard_pages WHERE dashboard_id = ? ORDER BY position", [dashboard_id]
        ).fetchall()
        ids = [p["id"] for p in pages]
        if page_id not in ids:
            return "missing"
        if len(ids) == 1:
            return "last"
        con.execute("DELETE FROM dashboard_items WHERE page_id = ?", [page_id])
        con.execute("DELETE FROM dashboard_pages WHERE id = ?", [page_id])
        for pos, pid in enumerate(i for i in ids if i != page_id):
            con.execute("UPDATE dashboard_pages SET position = ? WHERE id = ?", [pos, pid])
        return "deleted"


# --- items --------------------------------------------------------------


def _free_spot(con: sqlite3.Connection, page: sqlite3.Row, w: int, h: int) -> tuple[int, int]:
    """First top-left-most position where a w x h box fits on the page
    without overlapping anything already there (with a gap). If the page is
    full, it goes below everything and the page grows to fit it -- a newly
    added visual must never land hidden under another one."""
    rects = [
        (r["layout_x"], r["layout_y"], r["layout_w"], r["layout_h"])
        for r in con.execute("SELECT * FROM dashboard_items WHERE page_id = ?", [page["id"]])
    ]
    w = min(w, page["width"] - 2 * PAGE_MARGIN)

    def clear(x: int, y: int) -> bool:
        return all(x + w + GAP <= rx or rx + rw + GAP <= x or y + h + GAP <= ry or ry + rh + GAP <= y for rx, ry, rw, rh in rects)

    for y in range(PAGE_MARGIN, page["height"] - h - PAGE_MARGIN + 1, 8):
        for x in range(PAGE_MARGIN, page["width"] - w - PAGE_MARGIN + 1, 8):
            if clear(x, y):
                return x, y
    bottom = max((ry + rh for _, ry, _, rh in rects), default=0)
    y = bottom + GAP if rects else PAGE_MARGIN
    con.execute("UPDATE dashboard_pages SET height = MAX(height, ?) WHERE id = ?", [y + h + PAGE_MARGIN, page["id"]])
    return PAGE_MARGIN, y


def add_item(
    dashboard_id: str,
    question: str,
    sql: str,
    chart_type: str,
    chart_x: Optional[str],
    chart_y: Optional[str],
    chart_series: Optional[str],
    narration: Optional[str],
    kind: str = "chart",
    text: Optional[str] = None,
    config: Optional[dict] = None,
    page_id: Optional[str] = None,
    rect: Optional[tuple[int, int, int, int]] = None,
) -> Optional[dict]:
    """`page_id` None = the report's first page. `rect` (x, y, w, h) None =
    default size at the first free spot."""
    with _connection() as con:
        if page_id is None:
            page = con.execute(
                "SELECT * FROM dashboard_pages WHERE dashboard_id = ? ORDER BY position LIMIT 1", [dashboard_id]
            ).fetchone()
        else:
            page = con.execute(
                "SELECT * FROM dashboard_pages WHERE id = ? AND dashboard_id = ?", [page_id, dashboard_id]
            ).fetchone()
        if page is None:
            return None
        if rect is None:
            w, h = TEXT_SIZE if kind == "text" else CHART_SIZE
            x, y = _free_spot(con, page, w, h)
            rect = (x, y, min(w, page["width"] - 2 * PAGE_MARGIN), h)
        z = con.execute(
            "SELECT COALESCE(MAX(layout_z), 0) + 1 FROM dashboard_items WHERE page_id = ?", [page["id"]]
        ).fetchone()[0]
        row = {
            "id": uuid.uuid4().hex,
            "dashboard_id": dashboard_id,
            "page_id": page["id"],
            "question": question,
            "sql": sql,
            "chart_type": chart_type,
            "chart_x": chart_x,
            "chart_y": chart_y,
            "chart_series": chart_series,
            "narration": narration,
            "layout_x": rect[0],
            "layout_y": rect[1],
            "layout_w": rect[2],
            "layout_h": rect[3],
            "layout_z": z,
            "layout_units": "px",
            "created_at": _now(),
            "kind": kind,
            "text": text,
            "config_json": json.dumps(config or {}),
        }
        con.execute(
            """INSERT INTO dashboard_items
               (id, dashboard_id, page_id, question, sql, chart_type, chart_x, chart_y, chart_series,
                narration, layout_x, layout_y, layout_w, layout_h, layout_z, layout_units, created_at,
                kind, text, config_json)
               VALUES (:id, :dashboard_id, :page_id, :question, :sql, :chart_type, :chart_x, :chart_y,
                       :chart_series, :narration, :layout_x, :layout_y, :layout_w, :layout_h, :layout_z,
                       :layout_units, :created_at, :kind, :text, :config_json)""",
            row,
        )
        row["config"] = json.loads(row.pop("config_json"))
        return row


def get_item(dashboard_id: str, item_id: str) -> Optional[dict]:
    with _connection() as con:
        r = con.execute(
            "SELECT * FROM dashboard_items WHERE id = ? AND dashboard_id = ?", [item_id, dashboard_id]
        ).fetchone()
        return _item_row(r) if r else None


def update_item(
    dashboard_id: str, item_id: str, config: Optional[dict] = None, text: Optional[str] = None
) -> Optional[dict]:
    """`config` REPLACES the stored config wholesale (the client always sends
    the full object) -- simpler and less surprising than a deep merge."""
    with _connection() as con:
        if config is not None:
            con.execute(
                "UPDATE dashboard_items SET config_json = ? WHERE id = ? AND dashboard_id = ?",
                [json.dumps(config), item_id, dashboard_id],
            )
        if text is not None:
            con.execute(
                "UPDATE dashboard_items SET text = ? WHERE id = ? AND dashboard_id = ?", [text, item_id, dashboard_id]
            )
    return get_item(dashboard_id, item_id)


def delete_item(dashboard_id: str, item_id: str) -> bool:
    with _connection() as con:
        cur = con.execute(
            "DELETE FROM dashboard_items WHERE id = ? AND dashboard_id = ?", [item_id, dashboard_id]
        )
        return cur.rowcount > 0


def update_layout(dashboard_id: str, items: list[dict]) -> None:
    """`items` is a list of {id, x, y, w, h, z?} in page pixels. Silently
    skips any id that doesn't belong to this dashboard rather than raising --
    a stale tile the client hasn't refreshed yet shouldn't fail the batch."""
    with _connection() as con:
        for item in items:
            con.execute(
                """UPDATE dashboard_items SET layout_x = ?, layout_y = ?, layout_w = ?, layout_h = ?,
                   layout_z = COALESCE(?, layout_z), layout_units = 'px'
                   WHERE id = ? AND dashboard_id = ?""",
                [item["x"], item["y"], item["w"], item["h"], item.get("z"), item["id"], dashboard_id],
            )
