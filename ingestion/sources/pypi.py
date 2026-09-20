"""PyPI downloads source — second product line usage signal, zero-auth.

pypistats.org rate-limits aggressively and sends no Retry-After header, so
requests here retry a few times with a short fixed backoff before giving up
(the caller's _safe() wrapper still catches a final failure).
"""

import time
from datetime import date, datetime, timedelta, timezone

import duckdb
import httpx

PYPISTATS_API = "https://pypistats.org/api/packages"
RETRY_DELAYS = [1, 3, 8]


def _get_with_retry(client: httpx.Client, url: str, **kwargs) -> httpx.Response:
    for delay in [*RETRY_DELAYS, None]:
        r = client.get(url, **kwargs)
        if r.status_code != 429 or delay is None:
            return r
        time.sleep(delay)
    return r


def fetch_pypi_downloads(
    con: duckdb.DuckDBPyConnection, client: httpx.Client, package: str
) -> None:
    r = _get_with_retry(client, f"{PYPISTATS_API}/{package}/recent")
    if r.status_code == 404:
        return
    r.raise_for_status()
    downloads = r.json()["data"]["last_day"]

    con.execute(
        "INSERT INTO pypi_downloads (package, downloads, day, captured_at) VALUES (?, ?, ?, ?)",
        [package, downloads, date.today() - timedelta(days=1), datetime.now(timezone.utc)],
    )


def backfill_pypi_downloads(
    con: duckdb.DuckDBPyConnection, client: httpx.Client, package: str
) -> None:
    """Daily download counts pypistats has on hand — they only retain a rolling
    ~180 days, so this is the full history available, not a chosen window."""
    r = _get_with_retry(client, f"{PYPISTATS_API}/{package}/overall", params={"mirrors": "false"})
    if r.status_code == 404:
        return
    r.raise_for_status()
    captured_at = datetime.now(timezone.utc)

    for point in r.json()["data"]:
        day = date.fromisoformat(point["date"])
        exists = con.execute(
            "SELECT 1 FROM pypi_downloads WHERE package = ? AND day = ?", [package, day]
        ).fetchone()
        if exists:
            continue
        con.execute(
            "INSERT INTO pypi_downloads (package, downloads, day, captured_at) VALUES (?, ?, ?, ?)",
            [package, point["downloads"], day, captured_at],
        )
