"""Daily entry point for Windows Task Scheduler — one poll cycle + one backup,
then exit. Replaces the continuous in-process APScheduler for now: with GitHub
event volume well under its 300-event cap per day and npm/pypi already daily
aggregates, a once-a-day run loses nothing, and it means the machine only
needs to be on briefly at trigger time, not running a server all day.

Logs to data/logs/daily_poll.log since Task Scheduler runs headless — check
that file to confirm a run actually happened.
"""

import logging
import socket
import sys
import time
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

LOG_DIR = Path(__file__).resolve().parent.parent / "data" / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    handlers=[logging.FileHandler(LOG_DIR / "daily_poll.log", encoding="utf-8")],
)
logger = logging.getLogger("askql.daily_poll")

from dotenv import load_dotenv

load_dotenv()

from ingestion import db
from ingestion.backup import backup_db
from ingestion.scheduler import poll_all_sources

# Task Scheduler's WakeToRun/StartWhenAvailable can fire this the instant the
# machine wakes or logs in, before Wi-Fi has reconnected — a bare run then
# fails every source with DNS errors (observed 2026-09-20: 20/20 calls failed,
# getaddrinfo failed). Wait for real DNS resolution before touching any source.
NETWORK_CHECK_HOST = "api.github.com"
NETWORK_WAIT_ATTEMPTS = 10
NETWORK_WAIT_SECONDS = 6


def wait_for_network() -> bool:
    for attempt in range(1, NETWORK_WAIT_ATTEMPTS + 1):
        try:
            socket.gethostbyname(NETWORK_CHECK_HOST)
            return True
        except OSError:
            logger.warning(
                "network not ready (attempt %d/%d), retrying in %ds",
                attempt, NETWORK_WAIT_ATTEMPTS, NETWORK_WAIT_SECONDS,
            )
            time.sleep(NETWORK_WAIT_SECONDS)
    return False


def main() -> None:
    logger.info("daily poll starting")
    if not wait_for_network():
        logger.error(
            "no network after %d attempts, aborting run without touching sources",
            NETWORK_WAIT_ATTEMPTS,
        )
        return
    con = db.get_connection()
    try:
        poll_all_sources(con)
        backup_db(con)
        logger.info("daily poll done")
    finally:
        con.close()


if __name__ == "__main__":
    main()
