"""FastAPI app skeleton — data generation lives in the Windows Task Scheduler
job (ingestion/run_daily_poll.py), not here, so this doesn't duplicate the
single DuckDB writer with two schedulers touching the same file. This app is
for later phases (agent /chat endpoint) — for now, read-only inspection.
"""

import logging
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI

from ingestion import db

load_dotenv()
logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(app: FastAPI):
    con = db.get_connection()
    app.state.db = con
    yield
    con.close()


app = FastAPI(title="AskQL", lifespan=lifespan)


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
