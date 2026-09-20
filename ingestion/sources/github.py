"""GitHub REST API source: repo snapshots (stars, open issues) and the events feed.

ETag caching is required, not optional (CLAUDE.md) — unauthenticated GitHub is
60 req/hr, and a 304 response doesn't count against the limit.
"""

import logging
import os
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlparse

import duckdb
import httpx

from .. import db

GITHUB_API = "https://api.github.com"
logger = logging.getLogger("askql.ingestion")


def _auth_headers(accept: str = "application/vnd.github+json") -> dict:
    headers = {"Accept": accept, "User-Agent": "askql-ingestion"}
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _classic_auth_headers(accept: str = "application/vnd.github+json") -> dict:
    """Stargazers-with-timestamp needs a classic PAT — fine-grained tokens get
    a 403 on this endpoint regardless of scopes granted (documented GitHub
    gap). Falls back to the fine-grained token if no classic one is set, which
    will 403 and get skipped by the caller same as before."""
    headers = {"Accept": accept, "User-Agent": "askql-ingestion"}
    token = os.environ.get("GITHUB_CLASSIC_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _headers(con: duckdb.DuckDBPyConnection, cache_key: str) -> dict:
    headers = _auth_headers()
    etag = db.get_etag(con, cache_key)
    if etag:
        headers["If-None-Match"] = etag
    return headers


def _iso(ts: str | None):
    return datetime.fromisoformat(ts.replace("Z", "+00:00")) if ts else None


def fetch_repo_snapshot(
    con: duckdb.DuckDBPyConnection, client: httpx.Client, repo: str
) -> None:
    cache_key = f"github:repo:{repo}"
    r = client.get(f"{GITHUB_API}/repos/{repo}", headers=_headers(con, cache_key))
    if r.status_code == 304:
        return
    r.raise_for_status()
    if "etag" in r.headers:
        db.set_etag(con, cache_key, r.headers["etag"])

    d = r.json()
    con.execute(
        "INSERT INTO repo_snapshots VALUES (?, ?, ?, ?)",
        [d["full_name"], d["stargazers_count"], d["open_issues_count"], datetime.now(timezone.utc)],
    )


def fetch_repo_events(
    con: duckdb.DuckDBPyConnection, client: httpx.Client, repo: str
) -> None:
    cache_key = f"github:events:{repo}"
    r = client.get(
        f"{GITHUB_API}/repos/{repo}/events",
        headers=_headers(con, cache_key),
        params={"per_page": 100},
    )
    if r.status_code == 304:
        return
    r.raise_for_status()
    if "etag" in r.headers:
        db.set_etag(con, cache_key, r.headers["etag"])

    captured_at = datetime.now(timezone.utc)
    for event in r.json():
        con.execute(
            """INSERT INTO repo_events VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT (event_id) DO NOTHING""",
            [
                event["id"],
                repo,
                event["type"],
                (event.get("actor") or {}).get("login"),
                datetime.fromisoformat(event["created_at"].replace("Z", "+00:00")),
                captured_at,
            ],
        )


def backfill_stars(
    con: duckdb.DuckDBPyConnection, client: httpx.Client, repo: str, max_pages: int = 20
) -> None:
    """Most recent `max_pages` * 100 stargazers, timestamped. Big repos have
    thousands of pages of history — bounded here on purpose, not exhaustive.

    GitHub blocks /stargazers (and /subscribers) for every token type tried —
    fine-grained, classic with full `repo`+`admin:org` scope, Bearer/token/Basic
    auth, every Accept variant — confirmed on octocat/Hello-World, so it's not
    this account or repo. /forks, /contributors, /languages all work fine with
    the same token. Reads as a platform-side restriction on social-graph
    listing endpoints, not something fixable from a token or header change.
    Accepted, permanent gap — star_history stays empty. Skips quietly rather
    than crashing the rest of the backfill."""
    headers = _classic_auth_headers(accept="application/vnd.github.star+json")
    r = client.get(
        f"{GITHUB_API}/repos/{repo}/stargazers",
        headers=headers,
        params={"per_page": 100, "page": 1},
    )
    if r.status_code in (403, 404):
        logger.warning(
            "stargazers backfill skipped for %s: %d (GitHub blocks this endpoint platform-wide, not a token issue)",
            repo, r.status_code,
        )
        return
    r.raise_for_status()
    last_page = 1
    if "last" in r.links:
        last_page = int(parse_qs(urlparse(r.links["last"]["url"]).query)["page"][0])
    start_page = max(1, last_page - max_pages + 1)

    captured_at = datetime.now(timezone.utc)
    for page in range(start_page, last_page + 1):
        rr = client.get(
            f"{GITHUB_API}/repos/{repo}/stargazers",
            headers=headers,
            params={"per_page": 100, "page": page},
        )
        rr.raise_for_status()
        for item in rr.json():
            con.execute(
                """INSERT INTO star_history VALUES (?, ?, ?, ?)
                   ON CONFLICT (repo, user) DO NOTHING""",
                [repo, item["user"]["login"], _iso(item["starred_at"]), captured_at],
            )


def backfill_issues(
    con: duckdb.DuckDBPyConnection, client: httpx.Client, repo: str, max_pages: int = 10
) -> None:
    """Most recent `max_pages` * 100 issues (state=all), pull requests filtered
    out — GitHub's /issues endpoint returns both."""
    headers = _auth_headers()
    captured_at = datetime.now(timezone.utc)
    for page in range(1, max_pages + 1):
        r = client.get(
            f"{GITHUB_API}/repos/{repo}/issues",
            headers=headers,
            params={"state": "all", "sort": "created", "direction": "desc", "per_page": 100, "page": page},
        )
        r.raise_for_status()
        items = r.json()
        if not items:
            break
        for item in items:
            if "pull_request" in item:
                continue
            con.execute(
                """INSERT INTO issue_history VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT (repo, issue_number) DO UPDATE SET
                       state = excluded.state,
                       closed_at = excluded.closed_at,
                       captured_at = excluded.captured_at""",
                [repo, item["number"], item["state"], _iso(item["created_at"]), _iso(item["closed_at"]), captured_at],
            )


def backfill_prs(
    con: duckdb.DuckDBPyConnection, client: httpx.Client, repo: str, max_pages: int = 10
) -> None:
    headers = _auth_headers()
    captured_at = datetime.now(timezone.utc)
    for page in range(1, max_pages + 1):
        r = client.get(
            f"{GITHUB_API}/repos/{repo}/pulls",
            headers=headers,
            params={"state": "all", "sort": "created", "direction": "desc", "per_page": 100, "page": page},
        )
        r.raise_for_status()
        items = r.json()
        if not items:
            break
        for item in items:
            con.execute(
                """INSERT INTO pr_history VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT (repo, pr_number) DO UPDATE SET
                       state = excluded.state,
                       merged_at = excluded.merged_at,
                       captured_at = excluded.captured_at""",
                [repo, item["number"], item["state"], _iso(item["created_at"]), _iso(item["merged_at"]), captured_at],
            )
