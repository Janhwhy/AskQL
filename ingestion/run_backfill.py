"""One-time historical backfill so charts have real history from day one,
instead of waiting weeks for live polling to accumulate it.

Run once (safe to rerun — sources dedupe on conflict):
    python ingestion/run_backfill.py
"""

import logging
import sys

import httpx
from dotenv import load_dotenv

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

load_dotenv()
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("askql.backfill")

from ingestion import config, db
from ingestion.sources import github, npm, pypi


def main() -> None:
    con = db.get_connection()
    with httpx.Client(timeout=30.0) as client:
        for repo in config.TRACKED_REPOS:
            logger.info("backfilling %s", repo)
            _safe(github.backfill_stars, con, client, repo)
            _safe(github.backfill_issues, con, client, repo)
            _safe(github.backfill_prs, con, client, repo)

        for package in config.NPM_PACKAGES:
            logger.info("backfilling npm %s", package)
            _safe(npm.backfill_npm_downloads, con, client, package)

        for package in config.PYPI_PACKAGES:
            logger.info("backfilling pypi %s", package)
            _safe(pypi.backfill_pypi_downloads, con, client, package)

    for table in ["star_history", "issue_history", "pr_history", "npm_downloads", "pypi_downloads"]:
        count = con.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
        print(f"{table}: {count} rows")
    con.close()


def _safe(fn, con, client, arg) -> None:
    try:
        fn(con, client, arg)
    except Exception:
        logger.exception("backfill failed: %s(%s)", fn.__name__, arg)


if __name__ == "__main__":
    main()
