"""Scheduled copy of the DuckDB file. Single-file DB means a copy is the whole
insurance policy — cheap, so keep the last 7 and prune older ones.

Uses DuckDB's own ATTACH + COPY FROM DATABASE rather than a raw filesystem
copy: on Windows, DuckDB holds an exclusive lock on its file, so `shutil.copy`
fails with a PermissionError even from the same process that opened it.
Going through DuckDB's own I/O layer sidesteps the lock entirely.
"""

import logging
from datetime import datetime, timezone

import duckdb

from . import db

logger = logging.getLogger("askql.ingestion")

BACKUP_DIR = db.DB_PATH.parent / "backups"
KEEP = 7


def backup_db(con: duckdb.DuckDBPyConnection) -> None:
    if not db.DB_PATH.exists():
        return
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)

    catalog = con.execute("PRAGMA database_list").fetchone()[1]
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    dest = BACKUP_DIR / f"askql_{stamp}.db"

    con.execute(f"ATTACH '{dest}' AS backup_{stamp}")
    con.execute(f'COPY FROM DATABASE "{catalog}" TO backup_{stamp}')
    con.execute(f"DETACH backup_{stamp}")
    logger.info("backed up askql.db -> %s", dest.name)

    backups = sorted(BACKUP_DIR.glob("askql_*.db"))
    for old in backups[:-KEEP]:
        old.unlink()
