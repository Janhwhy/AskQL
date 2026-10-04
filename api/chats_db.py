"""Saved-chat persistence (Phase 8) -- a SEPARATE SQLite file
(`data/chats.sqlite3`), same reasoning as `dashboards_db.py`: CLAUDE.md
constraint 1 keeps every user-driven write out of the DuckDB file the daily
poll job owns.

A chat's turns are a SNAPSHOT of what was answered at the time (rows included,
capped), unlike dashboard items which deliberately re-run their SQL live. A
transcript is a record of a conversation; silently changing an old answer's
numbers under the narration that described them would make the record lie.

The chat's id doubles as the agent's LangGraph `thread_id`, so the agent's own
conversational context (agent/graph.py's SqliteSaver checkpointer) and this
human-readable transcript stay keyed to the same conversation.
"""

import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Iterator, Optional

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "chats.sqlite3"

# A stored transcript only needs enough rows to redraw the chart/table it
# showed -- a "daily revenue since founding" answer can be ~600 rows, but an
# unbounded snapshot would let one careless question bloat the file forever.
MAX_STORED_ROWS = 2000
TITLE_MAX = 60

SCHEMA_STATEMENTS = [
    """CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS chat_turns (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        question TEXT NOT NULL,
        status TEXT NOT NULL,
        sql TEXT,
        columns_json TEXT,
        rows_json TEXT,
        chart_json TEXT,
        narration TEXT,
        clarification_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL
    )""",
    "CREATE INDEX IF NOT EXISTS idx_chat_turns_chat ON chat_turns(chat_id, seq)",
]


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


def _json_default(o):
    if isinstance(o, (date, datetime)):
        return o.isoformat()
    if isinstance(o, Decimal):
        return float(o)
    return str(o)


def _dumps(v) -> Optional[str]:
    return None if v is None else json.dumps(v, default=_json_default)


def _loads(v: Optional[str]):
    return None if v is None else json.loads(v)


def title_from_question(question: str) -> str:
    q = " ".join(question.split())
    return q if len(q) <= TITLE_MAX else q[: TITLE_MAX - 1].rstrip() + "…"


def ensure_chat(chat_id: str, first_question: Optional[str]) -> None:
    """Creates the chat row lazily on its first message. The title is derived
    from the first question in code -- no LLM call, since titling would add a
    round trip to every new chat against a p95 < 1s budget (constraint 6)."""
    with _connection() as con:
        exists = con.execute("SELECT 1 FROM chats WHERE id = ?", [chat_id]).fetchone()
        if exists is None:
            now = _now()
            con.execute(
                "INSERT INTO chats (id, title, pinned, created_at, updated_at) VALUES (?, ?, 0, ?, ?)",
                [chat_id, title_from_question(first_question or "New chat"), now, now],
            )


def list_chats() -> list[dict]:
    with _connection() as con:
        rows = con.execute(
            """SELECT c.id, c.title, c.pinned, c.created_at, c.updated_at, COUNT(t.id) AS turn_count
               FROM chats c LEFT JOIN chat_turns t ON t.chat_id = c.id
               GROUP BY c.id ORDER BY c.pinned DESC, c.updated_at DESC"""
        ).fetchall()
        return [{**dict(r), "pinned": bool(r["pinned"])} for r in rows]


def _turn_out(r: sqlite3.Row) -> dict:
    return {
        "id": r["id"],
        "question": r["question"],
        "status": r["status"],
        "sql": r["sql"],
        "columns": _loads(r["columns_json"]),
        "rows": _loads(r["rows_json"]) or [],
        "chart": _loads(r["chart_json"]),
        "narration": r["narration"],
        "clarification": _loads(r["clarification_json"]),
        "error": r["error"],
        "created_at": r["created_at"],
    }


def get_chat(chat_id: str) -> Optional[dict]:
    with _connection() as con:
        chat = con.execute("SELECT * FROM chats WHERE id = ?", [chat_id]).fetchone()
        if chat is None:
            return None
        turns = con.execute("SELECT * FROM chat_turns WHERE chat_id = ? ORDER BY seq", [chat_id]).fetchall()
        return {**dict(chat), "pinned": bool(chat["pinned"]), "turns": [_turn_out(t) for t in turns]}


def update_chat(chat_id: str, title: Optional[str] = None, pinned: Optional[bool] = None) -> Optional[dict]:
    with _connection() as con:
        if con.execute("SELECT 1 FROM chats WHERE id = ?", [chat_id]).fetchone() is None:
            return None
        # Renaming/pinning deliberately does NOT bump updated_at -- "recent"
        # means recent conversation, not recently tidied up.
        if title is not None:
            con.execute("UPDATE chats SET title = ? WHERE id = ?", [title, chat_id])
        if pinned is not None:
            con.execute("UPDATE chats SET pinned = ? WHERE id = ?", [int(pinned), chat_id])
        row = con.execute("SELECT * FROM chats WHERE id = ?", [chat_id]).fetchone()
        return {**dict(row), "pinned": bool(row["pinned"])}


def delete_chat(chat_id: str) -> bool:
    with _connection() as con:
        return con.execute("DELETE FROM chats WHERE id = ?", [chat_id]).rowcount > 0


def save_turn(chat_id: str, turn: dict, replace_last_clarification: bool = False) -> None:
    """Appends one finished turn. `replace_last_clarification`: the turn is the
    resolution of the chat's last turn, which was a clarification question --
    update that turn in place rather than appending, so the transcript reads
    as one question with one answer, the same way the UI showed it live."""
    rows = turn.get("rows") or []
    values = {
        "question": turn.get("question") or "",
        "status": turn["status"],
        "sql": turn.get("sql"),
        "columns_json": _dumps(turn.get("columns")),
        "rows_json": _dumps(rows[:MAX_STORED_ROWS]),
        "chart_json": _dumps(turn.get("chart")),
        "narration": turn.get("narration"),
        "clarification_json": _dumps(turn.get("clarification")),
        "error": turn.get("error"),
    }
    with _connection() as con:
        last = con.execute(
            "SELECT id, status, question FROM chat_turns WHERE chat_id = ? ORDER BY seq DESC LIMIT 1", [chat_id]
        ).fetchone()
        if replace_last_clarification and last is not None and last["status"] == "clarification":
            values["question"] = values["question"] or last["question"]
            con.execute(
                """UPDATE chat_turns SET question = :question, status = :status, sql = :sql,
                   columns_json = :columns_json, rows_json = :rows_json, chart_json = :chart_json,
                   narration = :narration, clarification_json = :clarification_json, error = :error
                   WHERE id = :id""",
                {**values, "id": last["id"]},
            )
        else:
            seq = con.execute(
                "SELECT COALESCE(MAX(seq), -1) + 1 FROM chat_turns WHERE chat_id = ?", [chat_id]
            ).fetchone()[0]
            con.execute(
                """INSERT INTO chat_turns (id, chat_id, seq, question, status, sql, columns_json, rows_json,
                       chart_json, narration, clarification_json, error, created_at)
                   VALUES (:id, :chat_id, :seq, :question, :status, :sql, :columns_json, :rows_json,
                       :chart_json, :narration, :clarification_json, :error, :created_at)""",
                {**values, "id": uuid.uuid4().hex, "chat_id": chat_id, "seq": seq, "created_at": _now()},
            )
        con.execute("UPDATE chats SET updated_at = ? WHERE id = ?", [_now(), chat_id])
