"""Polls every configured source once. Called on an interval by APScheduler,
inside the FastAPI process — see CLAUDE.md constraint 1 (single writer).
"""

import logging

import duckdb
import httpx

from . import config
from .sources import github, hn, npm, pypi

logger = logging.getLogger("askql.ingestion")


def poll_all_sources(con: duckdb.DuckDBPyConnection) -> None:
    with httpx.Client(timeout=15.0) as client:
        for repo in config.TRACKED_REPOS:
            _safe(github.fetch_repo_snapshot, con, client, repo)
            _safe(github.fetch_repo_events, con, client, repo)
            # keep issue/PR state (open -> closed/merged) fresh going forward —
            # bounded to recent pages, only recent items realistically flip state
            _safe(github.backfill_issues, con, client, repo, 3)
            _safe(github.backfill_prs, con, client, repo, 3)

        for package in config.NPM_PACKAGES:
            _safe(npm.fetch_npm_downloads, con, client, package)

        for package in config.PYPI_PACKAGES:
            _safe(pypi.fetch_pypi_downloads, con, client, package)

        for query in config.HN_QUERIES:
            _safe(hn.fetch_hn_mentions, con, client, query)


def _safe(fn, con: duckdb.DuckDBPyConnection, client: httpx.Client, arg: str, *extra) -> None:
    try:
        fn(con, client, arg, *extra)
    except Exception:
        logger.exception("poll failed: %s(%s)", fn.__name__, arg)
