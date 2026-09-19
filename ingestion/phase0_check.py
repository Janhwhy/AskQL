"""Phase 0: prove the data path. Fetch one repo, write to DuckDB, read it back.

Run twice, see two rows:
    python3 ingestion/phase0_check.py
    python3 ingestion/phase0_check.py
"""

import os
from pathlib import Path

import duckdb
import httpx
from dotenv import load_dotenv

load_dotenv()

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "askql.db"
REPO = "langchain-ai/langchain"
TOKEN = os.environ.get("GITHUB_TOKEN")


def main() -> None:
    con = duckdb.connect(str(DB_PATH))
    con.execute(
        """CREATE TABLE IF NOT EXISTS repo_snapshots
           (repo TEXT, stars INT, open_issues INT, captured_at TIMESTAMP)"""
    )

    headers = {"Authorization": f"Bearer {TOKEN}"} if TOKEN else {}
    r = httpx.get(f"https://api.github.com/repos/{REPO}", headers=headers)
    r.raise_for_status()
    d = r.json()

    con.execute(
        "INSERT INTO repo_snapshots VALUES (?, ?, ?, now())",
        [d["full_name"], d["stargazers_count"], d["open_issues_count"]],
    )

    print(f"rate limit remaining: {r.headers.get('x-ratelimit-remaining', '?')}")
    print(con.sql("SELECT * FROM repo_snapshots ORDER BY captured_at"))


if __name__ == "__main__":
    main()
