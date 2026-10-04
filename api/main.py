"""FastAPI app — data generation lives in the Windows Task Scheduler job
(ingestion/run_daily_poll.py), not here, so this doesn't duplicate the single
DuckDB writer with two schedulers touching the same file. This app only reads.

The app's own connection MUST be read_only=True: DuckDB allows one writer OR
many readers on a file, never a mix. agent/graph.py's run_sql node opens its
own separate read-only connection per request — that's only safe to coexist
with this app's connection because both are read-only. A write connection
here would deadlock the moment /chat tried to query.
"""

import json
import logging
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from agent.graph import ask_stream
from ingestion import db

from . import chats_db
from .chats import router as chats_router
from .dashboards import router as dashboards_router

load_dotenv()
logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(app: FastAPI):
    con = db.get_connection(read_only=True)
    app.state.db = con
    yield
    con.close()


app = FastAPI(title="AskQL", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(dashboards_router)
app.include_router(chats_router)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/stats")
def stats():
    con = app.state.db
    tables = ["products", "sales_reps", "customers", "sales", "support_tickets"]
    return {t: con.execute(f"SELECT count(*) FROM {t}").fetchone()[0] for t in tables}


@app.get("/sales")
def sales(limit: int = 20):
    con = app.state.db
    rows = con.execute(
        """SELECT s.date, p.name AS product, p.category, c.region, s.channel, s.amount
           FROM sales s
           JOIN products p ON p.product_id = s.product_id
           JOIN customers c ON c.customer_id = s.customer_id
           ORDER BY s.date DESC LIMIT ?""",
        [limit],
    ).fetchall()
    cols = [c[0] for c in con.description]
    return [dict(zip(cols, r)) for r in rows]


class ChatRequest(BaseModel):
    question: str | None = None
    thread_id: str | None = None
    clarification_answer: str | None = None
    # False = keep the agent's thread context (clarification round-trips
    # still work) but don't file it as a saved chat -- used by a dashboard's
    # "ask to add a tile" bar, which isn't a conversation the user expects
    # to find in their chat history.
    save: bool = True


def _default_json(o):
    import datetime

    if isinstance(o, (datetime.date, datetime.datetime)):
        return o.isoformat()
    return str(o)


def _turn_from_terminal_event(event: dict) -> dict | None:
    """Maps ask_stream()'s terminal event onto a saved transcript turn --
    the same shape web/lib/types.ts's Turn builds client-side live."""
    stage = event.get("stage")
    if stage == "done":
        return {
            "question": event.get("question"),
            "status": "done",
            "sql": event.get("sql"),
            "columns": event.get("columns"),
            "rows": event.get("rows"),
            "chart": event.get("chart"),
            "narration": event.get("narration"),
        }
    if stage == "error":
        return {"question": event.get("question"), "status": "error", "sql": event.get("sql"), "error": event.get("error")}
    if stage == "clarification":
        return {
            "question": event.get("question"),
            "status": "clarification",
            "clarification": {"question": event["clarification_needed"], "candidates": event["candidates"]},
        }
    return None


def _sse_events(req: ChatRequest):
    # Every thread_id is a saved chat (Phase 8). Persisted server-side on the
    # terminal event, so the transcript can't disagree with what the agent's
    # own checkpointed context recorded.
    persist = bool(req.thread_id) and req.save
    if persist:
        chats_db.ensure_chat(req.thread_id, req.question)
    for event in ask_stream(req.question, thread_id=req.thread_id, clarification_answer=req.clarification_answer):
        if persist:
            turn = _turn_from_terminal_event(event)
            if turn is not None:
                try:
                    chats_db.save_turn(
                        req.thread_id, turn, replace_last_clarification=req.clarification_answer is not None
                    )
                except Exception:
                    # Losing a transcript write must never kill the answer
                    # the user is watching stream in.
                    logging.getLogger("askql.chats").exception("failed to save chat turn")
        yield f"data: {json.dumps(event, default=_default_json)}\n\n"


@app.post("/chat")
def chat(req: ChatRequest):
    """Streams agent progress as Server-Sent Events — one real event per
    graph node as it actually completes (agent/graph.py's ask_stream), not a
    simulated typing effect. See ChatEvent in web/lib/types.ts for the
    frontend-side event shape this produces."""
    return StreamingResponse(_sse_events(req), media_type="text/event-stream")
