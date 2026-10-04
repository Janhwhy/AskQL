"""Phase 8: saved chats (persisted server-side from /chat's SSE stream) and
dashboard tile customization / text tiles. Both SQLite stores are pointed at
a tmp dir -- these tests never touch the real data/*.sqlite3 files.

TestClient is used WITHOUT its context manager on purpose: that skips the
app's lifespan, which opens the real DuckDB file -- nothing here needs it.
"""

import json

import pytest
from fastapi.testclient import TestClient

from api import chats_db, dashboards_db
from api import main as api_main


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(chats_db, "DB_PATH", tmp_path / "chats.sqlite3")
    monkeypatch.setattr(dashboards_db, "DB_PATH", tmp_path / "dashboards.sqlite3")
    return TestClient(api_main.app)


def _fake_stream(events_by_call):
    calls = iter(events_by_call)

    def fake(question, thread_id=None, clarification_answer=None):
        yield from next(calls)

    return fake


def _post_chat(client, **body):
    res = client.post("/chat", json=body)
    assert res.status_code == 200
    return [json.loads(line[5:]) for line in res.text.splitlines() if line.startswith("data:")]


DONE = {
    "stage": "done",
    "question": "revenue by region",
    "sql": "SELECT 1",
    "columns": ["region", "revenue"],
    "rows": [{"region": "EMEA", "revenue": 10.5}],
    "chart": {"chart_type": "bar", "x": "region", "y": "revenue", "series": None},
    "narration": "EMEA leads.",
}


def test_chat_turns_are_persisted_and_listed(client, monkeypatch):
    monkeypatch.setattr(api_main, "ask_stream", _fake_stream([[{"stage": "thinking"}, DONE]]))
    _post_chat(client, question="revenue by region", thread_id="c1")

    chats = client.get("/chats").json()
    assert [c["id"] for c in chats] == ["c1"]
    assert chats[0]["title"] == "revenue by region"
    assert chats[0]["turn_count"] == 1

    chat = client.get("/chats/c1").json()
    turn = chat["turns"][0]
    assert turn["status"] == "done"
    assert turn["rows"] == DONE["rows"]
    assert turn["chart"]["chart_type"] == "bar"


def test_clarification_resolution_updates_the_same_turn(client, monkeypatch):
    clarify = {
        "stage": "clarification",
        "question": "how's support doing?",
        "clarification_needed": "Opened or resolved?",
        "candidates": ["support_tickets_opened", "support_tickets_resolved"],
    }
    resolved = {**DONE, "question": "how's support doing?"}
    monkeypatch.setattr(api_main, "ask_stream", _fake_stream([[clarify], [resolved]]))

    _post_chat(client, question="how's support doing?", thread_id="c2")
    assert client.get("/chats/c2").json()["turns"][0]["status"] == "clarification"

    _post_chat(client, question=None, thread_id="c2", clarification_answer="tickets opened")
    turns = client.get("/chats/c2").json()["turns"]
    assert len(turns) == 1  # resolved in place, not appended
    assert turns[0]["status"] == "done"
    assert turns[0]["question"] == "how's support doing?"


def test_rename_pin_ordering_and_delete(client, monkeypatch):
    monkeypatch.setattr(api_main, "ask_stream", _fake_stream([[DONE], [DONE]]))
    monkeypatch.setattr("api.chats.forget_thread", lambda thread_id: None)
    _post_chat(client, question="first", thread_id="old")
    _post_chat(client, question="second", thread_id="new")

    # most recent first...
    assert [c["id"] for c in client.get("/chats").json()] == ["new", "old"]
    # ...but pinned beats recent
    assert client.patch("/chats/old", json={"pinned": True}).json()["pinned"] is True
    assert [c["id"] for c in client.get("/chats").json()] == ["old", "new"]

    assert client.patch("/chats/new", json={"title": "  Renamed  "}).json()["title"] == "Renamed"
    assert client.patch("/chats/new", json={"title": "   "}).status_code == 400

    assert client.delete("/chats/old").status_code == 200
    assert client.get("/chats/old").status_code == 404
    assert client.delete("/chats/old").status_code == 404


def test_no_thread_id_means_nothing_is_persisted(client, monkeypatch):
    monkeypatch.setattr(api_main, "ask_stream", _fake_stream([[DONE]]))
    _post_chat(client, question="revenue by region")
    assert client.get("/chats").json() == []


def test_save_false_keeps_thread_but_files_no_chat(client, monkeypatch):
    monkeypatch.setattr(api_main, "ask_stream", _fake_stream([[DONE]]))
    _post_chat(client, question="revenue by region", thread_id="dash-1", save=False)
    assert client.get("/chats").json() == []


def test_long_first_question_gets_truncated_title():
    title = chats_db.title_from_question("x " * 100)
    assert len(title) <= chats_db.TITLE_MAX and title.endswith("…")


# --- dashboards ---------------------------------------------------------


@pytest.fixture
def dashboard(client, monkeypatch):
    # Live re-run isn't what's under test here; skip DuckDB entirely.
    monkeypatch.setattr("api.dashboards._run_live", lambda sql: (["n"], [{"n": 1}], None))
    return client.post("/dashboards", json={"name": "Ops"}).json()


def _subset(small: dict, big: dict) -> bool:
    return all(big.get(k) == v for k, v in small.items())


def test_tile_config_round_trips_and_is_validated(client, dashboard):
    item = client.post(
        f"/dashboards/{dashboard['id']}/items",
        json={"question": "q", "sql": "SELECT 1 AS n", "chart_type": "kpi", "y": "n"},
    ).json()
    assert item["kind"] == "chart"
    assert item["config"]["display_type"] is None  # defaults filled in

    cfg = {"title": "Headline", "color": 3, "display_type": "area", "show_narration": False, "background": "#112233"}
    res = client.patch(f"/dashboards/{dashboard['id']}/items/{item['id']}", json={"config": cfg})
    assert _subset(cfg, res.json()["config"])

    reloaded = client.get(f"/dashboards/{dashboard['id']}").json()["items"][0]
    assert _subset(cfg, reloaded["config"])

    url = f"/dashboards/{dashboard['id']}/items/{item['id']}"
    assert client.patch(url, json={"config": {"color": 9}}).status_code == 422
    assert client.patch(url, json={"config": {"display_type": "radar"}}).status_code == 422
    assert client.patch(url, json={"config": {"background": "red; x: url(evil)"}}).status_code == 422
    assert client.patch(url, json={"config": {"font_family": "Comic Sans"}}).status_code == 422
    # text is only editable on text tiles
    assert client.patch(url, json={"text": "hi"}).status_code == 400


def test_text_box_is_sanitized_and_never_runs_sql(client, dashboard, monkeypatch):
    def boom(sql):
        raise AssertionError("a text tile must never reach the database")

    monkeypatch.setattr("api.dashboards._run_live", boom)
    tile = client.post(
        f"/dashboards/{dashboard['id']}/text",
        json={"text": "<b>Weekly</b> review", "rect": {"x": 40, "y": 48, "w": 320, "h": 80}},
    ).json()
    assert tile["kind"] == "text" and tile["text"] == "<b>Weekly</b> review"
    assert tile["config"]["text_format"] == "html"
    assert tile["layout"] == {"x": 40, "y": 48, "w": 320, "h": 80, "z": 1}

    evil = (
        '<p onclick="steal()" style="color: #ff0000; position: fixed; background: url(x)">hi</p>'
        "<script>alert(1)</script><img src=x onerror=alert(1)><a href=\"javascript:x\">link</a>"
        '<span style="font-family: Inter; font-size: 24px">ok</span>'
    )
    edited = client.patch(f"/dashboards/{dashboard['id']}/items/{tile['id']}", json={"text": evil}).json()
    out = edited["text"]
    for bad in ("onclick", "script", "alert", "<img", "<a", "href", "url(", "position"):
        assert bad not in out, (bad, out)
    assert '<p style="color: #ff0000">hi</p>' in out
    assert '<span style="font-family: Inter; font-size: 24px">ok</span>' in out
    assert "link" in out  # text content survives, only the tag is dropped

    fonts = client.patch(
        f"/dashboards/{dashboard['id']}/items/{tile['id']}",
        json={
            "text": '<span style="font-family: var(--font-inter), sans-serif">a</span>'
            '<span style="color: var(--font-x); font-family: var(--evil)">b</span>'
        },
    ).json()["text"]
    assert '<span style="font-family: var(--font-inter), sans-serif">a</span>' in fonts
    assert "var(--font-x)" not in fonts and "--evil" not in fonts  # var() only for our own font vars


def test_new_items_land_in_free_space_on_the_page(client, dashboard):
    layouts = [
        client.post(
            f"/dashboards/{dashboard['id']}/items",
            json={"question": "q", "sql": "SELECT 1 AS n", "chart_type": "kpi", "y": "n"},
        ).json()["layout"]
        for _ in range(3)
    ]
    a, b, c = layouts
    assert (a["x"], a["y"]) == (24, 24)
    for p, q in [(a, b), (a, c), (b, c)]:  # no two overlap
        assert (
            p["x"] + p["w"] <= q["x"]
            or q["x"] + q["w"] <= p["x"]
            or p["y"] + p["h"] <= q["y"]
            or q["y"] + q["h"] <= p["y"]
        )


def test_pages_add_rename_resize_delete(client, dashboard):
    d = client.get(f"/dashboards/{dashboard['id']}").json()
    assert [p["name"] for p in d["pages"]] == ["Page 1"]
    first = d["pages"][0]
    assert (first["width"], first["height"]) == (1280, 720)

    p2 = client.post(f"/dashboards/{dashboard['id']}/pages", json={}).json()
    assert p2["name"] == "Page 2" and p2["position"] == 1
    base = f"/dashboards/{dashboard['id']}/pages/{p2['id']}"
    upd = client.patch(base, json={"name": "Support", "height": 1080, "background": "#101010"}).json()
    assert (upd["name"], upd["height"], upd["background"]) == ("Support", 1080, "#101010")
    assert client.patch(base, json={"reset_background": True}).json()["background"] is None
    assert client.patch(base, json={"width": 10}).status_code == 422

    tile = client.post(
        f"/dashboards/{dashboard['id']}/items",
        json={"question": "q", "sql": "SELECT 1 AS n", "chart_type": "kpi", "page_id": p2["id"]},
    ).json()
    assert tile["page_id"] == p2["id"]

    assert client.delete(base).status_code == 200  # takes its visuals with it
    d = client.get(f"/dashboards/{dashboard['id']}").json()
    assert len(d["pages"]) == 1 and all(i["page_id"] == first["id"] for i in d["items"])
    assert client.delete(f"/dashboards/{dashboard['id']}/pages/{first['id']}").status_code == 400  # never the last


def test_duplicate_layout_z_and_rename_dashboard(client, dashboard):
    item = client.post(
        f"/dashboards/{dashboard['id']}/items",
        json={"question": "q", "sql": "SELECT 1 AS n", "chart_type": "kpi", "config": {"title": "T", "color": 2}},
    ).json()
    dup = client.post(f"/dashboards/{dashboard['id']}/items/{item['id']}/duplicate").json()
    assert dup["id"] != item["id"]
    assert dup["config"]["title"] == "T" and dup["config"]["color"] == 2
    assert (dup["layout"]["x"], dup["layout"]["y"]) == (item["layout"]["x"] + 24, item["layout"]["y"] + 24)
    assert dup["layout"]["z"] > item["layout"]["z"]  # lands on top

    client.put(
        f"/dashboards/{dashboard['id']}/layout",
        json={"items": [{"id": item["id"], "x": 400, "y": 200, "w": 320, "h": 200, "z": 9}]},
    )
    moved = next(i for i in client.get(f"/dashboards/{dashboard['id']}").json()["items"] if i["id"] == item["id"])
    assert moved["layout"] == {"x": 400, "y": 200, "w": 320, "h": 200, "z": 9}

    assert client.patch(f"/dashboards/{dashboard['id']}", json={"name": "Ops v2", "description": "weekly"}).status_code == 200
    d = client.get(f"/dashboards/{dashboard['id']}").json()
    assert (d["name"], d["description"]) == ("Ops v2", "weekly")
    assert client.patch(f"/dashboards/{dashboard['id']}", json={"name": " "}).status_code == 400


def test_old_database_is_migrated_in_place(tmp_path, monkeypatch):
    """A dashboards.sqlite3 from before Phase 8 (no kind/config/description,
    no pages, layouts in 12-column GRID units) must upgrade on first open:
    rows intact, a first page created, grid units converted to page pixels
    exactly once."""
    import sqlite3

    path = tmp_path / "legacy.sqlite3"
    con = sqlite3.connect(path)
    for stmt in dashboards_db.SCHEMA_STATEMENTS[:2]:
        con.execute(stmt)
    con.execute("INSERT INTO dashboards (id, name, created_at) VALUES ('d', 'Old', 'now')")
    con.execute(
        """INSERT INTO dashboard_items (id, dashboard_id, question, sql, chart_type, layout_x, layout_y,
           layout_w, layout_h, created_at) VALUES ('i', 'd', 'q', 'SELECT 1', 'kpi', 6, 20, 6, 8, 'now')"""
    )
    con.commit()
    con.close()

    monkeypatch.setattr(dashboards_db, "DB_PATH", path)
    d = dashboards_db.get_dashboard("d")
    assert d["description"] == ""
    item = d["items"][0]
    assert item["kind"] == "chart" and item["config"] == {}
    assert len(d["pages"]) == 1 and item["page_id"] == d["pages"][0]["id"]
    # grid (6, 20, 6x8) -> right half of the page, below the old fold
    assert (item["layout_x"], item["layout_y"], item["layout_w"]) == (656, 976, 608)
    assert d["pages"][0]["height"] >= item["layout_y"] + item["layout_h"]  # page grew to keep it visible

    again = dashboards_db.get_dashboard("d")["items"][0]  # idempotent: never converted twice
    assert (again["layout_x"], again["layout_y"]) == (656, 976)
