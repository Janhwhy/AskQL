"""FastAPI app + in-process ingestion scheduler.

Phase 1: this is the accumulation service. Run it and leave it running — the
scheduler polls all sources on `config.POLL_INTERVAL_SECONDS` and fires once
immediately on startup so data starts flowing right away.
"""

import logging
from contextlib import asynccontextmanager
from datetime import datetime

from apscheduler.schedulers.background import BackgroundScheduler
from dotenv import load_dotenv
from fastapi import FastAPI

from ingestion import config, db
from ingestion.backup import backup_db
from ingestion.scheduler import poll_all_sources

load_dotenv()
logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(app: FastAPI):
    con = db.get_connection()
    app.state.db = con

    scheduler = BackgroundScheduler()
    scheduler.add_job(
        poll_all_sources,
        "interval",
        seconds=config.POLL_INTERVAL_SECONDS,
        args=[con],
        next_run_time=datetime.now(),
    )
    scheduler.add_job(backup_db, "interval", days=1, args=[con])
    scheduler.start()
    app.state.scheduler = scheduler

    yield

    scheduler.shutdown()
    con.close()


app = FastAPI(title="AskQL ingestion", lifespan=lifespan)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/stats")
def stats():
    con = app.state.db
    tables = ["repo_snapshots", "repo_events", "npm_downloads", "pypi_downloads", "hn_mentions"]
    return {t: con.execute(f"SELECT count(*) FROM {t}").fetchone()[0] for t in tables}


@app.get("/snapshots")
def snapshots(limit: int = 20):
    con = app.state.db
    rows = con.execute(
        "SELECT * FROM repo_snapshots ORDER BY captured_at DESC LIMIT ?", [limit]
    ).fetchall()
    cols = [c[0] for c in con.description]
    return [dict(zip(cols, r)) for r in rows]
