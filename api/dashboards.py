"""Dashboard endpoints — save a chart from a chat turn ("pin"), arrange
pinned charts into named dashboards, and re-render them with fresh data on
every load ("live", not a snapshot).

Layout/metadata lives in `dashboards_db.py` (a separate SQLite file — see
that module's docstring for why). Actual chart DATA is never stored here:
each item stores only its `question`/`sql`/chart-shape/`narration`, and
`GET /dashboards/{id}` re-runs the stored SQL against the live DuckDB file
every time it's fetched, the same way a fresh chat question would, so a
dashboard reflects today's numbers instead of the numbers at pin time.

Every piece of SQL that reaches this router — whether freshly pinned or
re-run on load — goes back through `validate_select_only` before it ever
touches the database. CLAUDE.md constraint 3 doesn't carve out an exception
for "SQL the agent already validated once"; a dashboard item's stored SQL is
untrusted input again the moment it's read back, same as any other request
body.
"""

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from agent.validation import UnsafeSQLError, validate_select_only
from ingestion.db import get_connection

from . import dashboards_db as db

logger = logging.getLogger("askql.dashboards")

router = APIRouter(prefix="/dashboards", tags=["dashboards"])


class DashboardCreate(BaseModel):
    name: str


class DashboardSummary(BaseModel):
    id: str
    name: str
    created_at: str
    item_count: int


class PinItemRequest(BaseModel):
    question: str
    sql: str
    chart_type: str
    x: Optional[str] = None
    y: Optional[str] = None
    series: Optional[str] = None
    narration: Optional[str] = None


class LayoutItem(BaseModel):
    id: str
    x: int
    y: int
    w: int
    h: int


class LayoutUpdate(BaseModel):
    items: list[LayoutItem]


def _run_live(sql: str) -> tuple[Optional[list[str]], Optional[list[dict]], Optional[str]]:
    """Re-runs one item's stored SQL against the live, read-only DuckDB
    connection. Returns (columns, rows, error) -- exactly one of
    (columns/rows) or error is populated, never a partial mix, so the
    frontend can render "this tile failed" without guessing."""
    try:
        validate_select_only(sql)
    except UnsafeSQLError as e:
        return None, None, f"rejected by SQL validator: {e}"

    con = get_connection(read_only=True)
    try:
        result = con.execute(sql)
        rows = result.fetchall()
        columns = [c[0] for c in result.description]
        return columns, [dict(zip(columns, r)) for r in rows], None
    except Exception as e:
        # A dashboard tile can legitimately go stale -- e.g. a metric
        # definition changes shape after the tile was pinned. Surface it on
        # that ONE tile, never fail the whole dashboard load over it.
        logger.warning("dashboard item query failed: %s", e)
        return None, None, f"execution failed: {e}"


def _item_out(item: dict, live: bool = True) -> dict:
    columns, rows, error = _run_live(item["sql"]) if live else (None, None, None)
    return {
        "id": item["id"],
        "question": item["question"],
        "sql": item["sql"],
        "chart": {
            "chart_type": item["chart_type"],
            "x": item["chart_x"],
            "y": item["chart_y"],
            "series": item["chart_series"],
        },
        "narration": item["narration"],
        "layout": {"x": item["layout_x"], "y": item["layout_y"], "w": item["layout_w"], "h": item["layout_h"]},
        "columns": columns,
        "rows": rows,
        "error": error,
    }


@router.get("")
def list_dashboards() -> list[DashboardSummary]:
    return db.list_dashboards()


@router.post("")
def create_dashboard(body: DashboardCreate) -> DashboardSummary:
    if not body.name.strip():
        raise HTTPException(400, "name must not be empty")
    return {**db.create_dashboard(body.name.strip()), "item_count": 0}


@router.get("/{dashboard_id}")
def get_dashboard(dashboard_id: str) -> dict:
    dashboard = db.get_dashboard(dashboard_id)
    if dashboard is None:
        raise HTTPException(404, "dashboard not found")
    return {
        "id": dashboard["id"],
        "name": dashboard["name"],
        "created_at": dashboard["created_at"],
        "items": [_item_out(item) for item in dashboard["items"]],
    }


@router.delete("/{dashboard_id}")
def delete_dashboard(dashboard_id: str) -> dict:
    if not db.delete_dashboard(dashboard_id):
        raise HTTPException(404, "dashboard not found")
    return {"deleted": True}


@router.post("/{dashboard_id}/items")
def add_item(dashboard_id: str, body: PinItemRequest) -> dict:
    try:
        validate_select_only(body.sql)
    except UnsafeSQLError as e:
        raise HTTPException(400, f"rejected by SQL validator: {e}") from e

    item = db.add_item(
        dashboard_id,
        question=body.question,
        sql=body.sql,
        chart_type=body.chart_type,
        chart_x=body.x,
        chart_y=body.y,
        chart_series=body.series,
        narration=body.narration,
    )
    if item is None:
        raise HTTPException(404, "dashboard not found")
    return _item_out(item)


@router.delete("/{dashboard_id}/items/{item_id}")
def remove_item(dashboard_id: str, item_id: str) -> dict:
    if not db.delete_item(dashboard_id, item_id):
        raise HTTPException(404, "item not found")
    return {"deleted": True}


@router.put("/{dashboard_id}/layout")
def update_layout(dashboard_id: str, body: LayoutUpdate) -> dict:
    if db.get_dashboard(dashboard_id) is None:
        raise HTTPException(404, "dashboard not found")
    db.update_layout(dashboard_id, [item.model_dump() for item in body.items])
    return {"updated": True}
