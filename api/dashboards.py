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
from typing import Annotated, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, StringConstraints

from agent.validation import UnsafeSQLError, validate_select_only
from ingestion.db import get_connection

from . import dashboards_db as db
from .richtext import sanitize_html

logger = logging.getLogger("askql.dashboards")

router = APIRouter(prefix="/dashboards", tags=["dashboards"])


class DashboardCreate(BaseModel):
    name: str


class DashboardSummary(BaseModel):
    id: str
    name: str
    description: str = ""
    created_at: str
    item_count: int
    thumb: list[dict] = []
    thumb_page: dict = {"w": db.PAGE_W, "h": db.PAGE_H}


class DashboardUpdate(BaseModel):
    name: Optional[str] = Field(default=None, max_length=120)
    description: Optional[str] = Field(default=None, max_length=500)


# Presentation-only overrides for a visual (Phase 8/8b). None of these touch
# the stored SQL -- `display_type` re-renders the SAME live rows a different
# way, exactly like the chat's chart-type follow-ups do, so customizing a
# visual can never change which numbers it shows. Validated here so a
# malformed config fails loudly at write time instead of breaking a visual
# at render time.
DisplayType = Literal["line", "area", "bar", "hbar", "pie", "donut", "table", "kpi"]
# Sans families only -- the text-box font picker's whole menu.
FontFamily = Literal["geist", "inter", "dm_sans", "manrope", "space_grotesk", "plex_sans", "work_sans"]
Hex = Annotated[str, StringConstraints(pattern=r"^(#[0-9a-fA-F]{6}|transparent)$")]


class TileConfig(BaseModel):
    # charts
    title: Optional[str] = Field(default=None, max_length=160)
    color: Optional[int] = Field(default=None, ge=1, le=8)  # palette slot, --series-N
    display_type: Optional[DisplayType] = None
    show_narration: bool = True
    show_legend: bool = True
    show_title: bool = True
    # container (charts + text boxes). None = that kind's own default.
    background: Optional[Hex] = None
    border: Optional[bool] = None
    shadow: Optional[bool] = None
    radius: Optional[int] = Field(default=None, ge=0, le=48)
    padding: Optional[int] = Field(default=None, ge=0, le=64)
    # text boxes -- box-level defaults; per-selection bold/italic/underline/
    # size/color live inline in the (sanitized) HTML itself.
    font_family: FontFamily = "geist"
    font_size: int = Field(default=16, ge=8, le=120)
    text_color: Optional[Hex] = None
    align: Literal["left", "center", "right", "justify"] = "left"
    valign: Literal["top", "middle", "bottom"] = "top"
    line_height: float = Field(default=1.45, ge=1.0, le=2.5)
    # "markdown": a pre-8b plain/markdown text tile; "html": rich text.
    text_format: Literal["markdown", "html"] = "markdown"


class ItemUpdate(BaseModel):
    config: Optional[TileConfig] = None
    text: Optional[str] = Field(default=None, max_length=50_000)


class Rect(BaseModel):
    x: int = Field(ge=0)
    y: int = Field(ge=0)
    w: int = Field(ge=24)
    h: int = Field(ge=24)


class TextTileCreate(BaseModel):
    text: str = Field(default="", max_length=50_000)
    page_id: Optional[str] = None
    rect: Optional[Rect] = None
    config: Optional[TileConfig] = None


class PinItemRequest(BaseModel):
    question: str
    sql: str
    chart_type: str
    x: Optional[str] = None
    y: Optional[str] = None
    series: Optional[str] = None
    narration: Optional[str] = None
    config: Optional[TileConfig] = None
    page_id: Optional[str] = None


class LayoutItem(BaseModel):
    id: str
    x: int
    y: int
    w: int = Field(ge=24)
    h: int = Field(ge=24)
    z: Optional[int] = None


class LayoutUpdate(BaseModel):
    items: list[LayoutItem]


class PageCreate(BaseModel):
    name: Optional[str] = Field(default=None, max_length=80)


class PageUpdate(BaseModel):
    name: Optional[str] = Field(default=None, max_length=80)
    width: Optional[int] = Field(default=None, ge=320, le=4000)
    height: Optional[int] = Field(default=None, ge=240, le=8000)
    background: Optional[Hex] = None
    # explicit flag so "reset to the theme default" (None) is distinguishable
    # from "background not being changed"
    reset_background: bool = False


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
    kind = item.get("kind") or "chart"
    # A text tile has no SQL by construction -- nothing to validate or run.
    # This is NOT a validation bypass: _run_live is the only path to the
    # database, and a text tile never calls it, whatever its `sql` column says.
    if kind == "chart" and live:
        columns, rows, error = _run_live(item["sql"])
    else:
        columns, rows, error = None, None, None
    return {
        "id": item["id"],
        "kind": kind,
        "page_id": item.get("page_id"),
        "text": item.get("text"),
        "config": TileConfig(**(item.get("config") or {})).model_dump(),
        "question": item["question"],
        "sql": item["sql"],
        "chart": {
            "chart_type": item["chart_type"],
            "x": item["chart_x"],
            "y": item["chart_y"],
            "series": item["chart_series"],
        },
        "narration": item["narration"],
        "layout": {
            "x": item["layout_x"],
            "y": item["layout_y"],
            "w": item["layout_w"],
            "h": item["layout_h"],
            "z": item.get("layout_z") or 0,
        },
        "columns": columns,
        "rows": rows,
        "error": error,
    }


def _page_out(p: dict) -> dict:
    return {k: p[k] for k in ("id", "name", "position", "width", "height", "background")}


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
        "description": dashboard.get("description") or "",
        "created_at": dashboard["created_at"],
        "pages": [_page_out(p) for p in dashboard["pages"]],
        "items": [_item_out(item) for item in dashboard["items"]],
    }


@router.patch("/{dashboard_id}")
def update_dashboard(dashboard_id: str, body: DashboardUpdate) -> dict:
    name = body.name.strip() if body.name is not None else None
    if name is not None and not name:
        raise HTTPException(400, "name must not be empty")
    if not db.update_dashboard(dashboard_id, name=name, description=body.description):
        raise HTTPException(404, "dashboard not found")
    return {"updated": True}


@router.delete("/{dashboard_id}")
def delete_dashboard(dashboard_id: str) -> dict:
    if not db.delete_dashboard(dashboard_id):
        raise HTTPException(404, "dashboard not found")
    return {"deleted": True}


# --- pages --------------------------------------------------------------


@router.post("/{dashboard_id}/pages")
def add_page(dashboard_id: str, body: PageCreate) -> dict:
    name = body.name.strip() if body.name and body.name.strip() else None
    page = db.add_page(dashboard_id, name)
    if page is None:
        raise HTTPException(404, "dashboard not found")
    return _page_out(page)


@router.patch("/{dashboard_id}/pages/{page_id}")
def update_page(dashboard_id: str, page_id: str, body: PageUpdate) -> dict:
    if db.get_page(dashboard_id, page_id) is None:
        raise HTTPException(404, "page not found")
    fields = body.model_dump(exclude_none=True, exclude={"reset_background"})
    if "name" in fields:
        fields["name"] = fields["name"].strip()
        if not fields["name"]:
            raise HTTPException(400, "name must not be empty")
    if body.reset_background:
        fields["background"] = None
    return _page_out(db.update_page(dashboard_id, page_id, fields))


@router.delete("/{dashboard_id}/pages/{page_id}")
def delete_page(dashboard_id: str, page_id: str) -> dict:
    result = db.delete_page(dashboard_id, page_id)
    if result == "missing":
        raise HTTPException(404, "page not found")
    if result == "last":
        raise HTTPException(400, "a report must keep at least one page")
    return {"deleted": True}


# --- items --------------------------------------------------------------


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
        config=body.config.model_dump() if body.config else None,
        page_id=body.page_id,
    )
    if item is None:
        raise HTTPException(404, "dashboard or page not found")
    return _item_out(item)


@router.post("/{dashboard_id}/text")
def add_text_tile(dashboard_id: str, body: TextTileCreate) -> dict:
    config = (body.config or TileConfig()).model_dump()
    config["text_format"] = "html"
    rect = body.rect
    item = db.add_item(
        dashboard_id,
        question="",
        sql="",
        chart_type="text",
        chart_x=None,
        chart_y=None,
        chart_series=None,
        narration=None,
        kind="text",
        text=sanitize_html(body.text),
        config=config,
        page_id=body.page_id,
        rect=(rect.x, rect.y, rect.w, rect.h) if rect else None,
    )
    if item is None:
        raise HTTPException(404, "dashboard or page not found")
    return _item_out(item)


@router.patch("/{dashboard_id}/items/{item_id}")
def update_item(dashboard_id: str, item_id: str, body: ItemUpdate) -> dict:
    existing = db.get_item(dashboard_id, item_id)
    if existing is None:
        raise HTTPException(404, "item not found")
    if body.text is not None and existing.get("kind") != "text":
        raise HTTPException(400, "only text tiles have editable text")
    config = body.config.model_dump() if body.config else None
    text = None
    if body.text is not None:
        # Rich text is HTML from contentEditable -- stored ONLY after the
        # allowlist sanitizer (api/richtext.py), so what the dashboard later
        # renders as HTML can never carry script, handlers, or links.
        text = sanitize_html(body.text)
        config = config or TileConfig(**(existing.get("config") or {})).model_dump()
        config["text_format"] = "html"
    item = db.update_item(dashboard_id, item_id, config=config, text=text)
    return _item_out(item)


@router.post("/{dashboard_id}/items/{item_id}/duplicate")
def duplicate_item(dashboard_id: str, item_id: str) -> dict:
    src = db.get_item(dashboard_id, item_id)
    if src is None:
        raise HTTPException(404, "item not found")
    if src.get("kind") == "chart":
        # Re-validated even though it was validated on pin -- constraint 3:
        # stored SQL is untrusted input again the moment it's read back.
        try:
            validate_select_only(src["sql"])
        except UnsafeSQLError as e:
            raise HTTPException(400, f"rejected by SQL validator: {e}") from e
    page = db.get_page(dashboard_id, src["page_id"])
    # Offset the copy like a design tool does, kept on the page.
    x = min(src["layout_x"] + 24, max(0, page["width"] - src["layout_w"]))
    y = min(src["layout_y"] + 24, max(0, page["height"] - src["layout_h"]))
    item = db.add_item(
        dashboard_id,
        question=src["question"],
        sql=src["sql"],
        chart_type=src["chart_type"],
        chart_x=src["chart_x"],
        chart_y=src["chart_y"],
        chart_series=src["chart_series"],
        narration=src["narration"],
        kind=src.get("kind") or "chart",
        text=src.get("text"),
        config=src.get("config"),
        page_id=src["page_id"],
        rect=(x, y, src["layout_w"], src["layout_h"]),
    )
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
