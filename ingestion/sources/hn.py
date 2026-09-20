"""Hacker News mentions source — marketing reach signal, zero-auth.

The firebaseio.com/v0 API used elsewhere in this project has no keyword search,
so mentions are pulled from the Algolia HN Search API instead (also zero-auth,
the standard way to query HN by keyword).
"""

from datetime import datetime, timezone

import duckdb
import httpx

HN_ALGOLIA_API = "https://hn.algolia.com/api/v1/search"


def fetch_hn_mentions(
    con: duckdb.DuckDBPyConnection, client: httpx.Client, query: str
) -> None:
    r = client.get(
        HN_ALGOLIA_API,
        params={"query": query, "tags": "story", "hitsPerPage": 20},
    )
    r.raise_for_status()
    captured_at = datetime.now(timezone.utc)

    for hit in r.json()["hits"]:
        con.execute(
            "INSERT INTO hn_mentions VALUES (?, ?, ?, ?, ?, ?, ?)",
            [
                query,
                int(hit["objectID"]),
                hit.get("title"),
                hit.get("points") or 0,
                hit.get("num_comments") or 0,
                datetime.fromisoformat(hit["created_at"].replace("Z", "+00:00")),
                captured_at,
            ],
        )
