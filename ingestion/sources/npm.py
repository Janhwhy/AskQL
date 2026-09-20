"""npm downloads source — product usage signal, zero-auth."""

from datetime import date, datetime, timedelta, timezone
from urllib.parse import quote

import duckdb
import httpx

NPM_API = "https://api.npmjs.org/downloads/point/last-day"


def fetch_npm_downloads(
    con: duckdb.DuckDBPyConnection, client: httpx.Client, package: str
) -> None:
    r = client.get(f"{NPM_API}/{quote(package, safe='')}")
    if r.status_code == 404:
        return
    r.raise_for_status()
    d = r.json()

    con.execute(
        "INSERT INTO npm_downloads VALUES (?, ?, ?, ?, ?)",
        [
            d["package"],
            d["downloads"],
            date.fromisoformat(d["start"]),
            date.fromisoformat(d["end"]),
            datetime.now(timezone.utc),
        ],
    )


def backfill_npm_downloads(
    con: duckdb.DuckDBPyConnection, client: httpx.Client, package: str, days: int = 548
) -> None:
    """Daily download counts for the last `days` (npm's range endpoint caps at
    ~18 months per call — 548 days). One row per historical day; skips days
    already backfilled so reruns don't duplicate."""
    end = date.today() - timedelta(days=1)
    start = end - timedelta(days=days - 1)
    period = f"{start.isoformat()}:{end.isoformat()}"
    r = client.get(f"https://api.npmjs.org/downloads/range/{period}/{quote(package, safe='')}")
    if r.status_code == 404:
        return
    r.raise_for_status()
    d = r.json()
    captured_at = datetime.now(timezone.utc)

    for point in d["downloads"]:
        day = date.fromisoformat(point["day"])
        exists = con.execute(
            "SELECT 1 FROM npm_downloads WHERE package = ? AND period_start = ? AND period_end = ?",
            [d["package"], day, day],
        ).fetchone()
        if exists:
            continue
        con.execute(
            "INSERT INTO npm_downloads VALUES (?, ?, ?, ?, ?)",
            [d["package"], point["downloads"], day, day, captured_at],
        )
