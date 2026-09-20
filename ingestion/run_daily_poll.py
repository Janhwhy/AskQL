"""Daily entry point for Windows Task Scheduler — generates today's row of
company data (sales, tickets, new customers, churn) + one backup, then exits.

2026-09-20: repointed at the simulated-company generator (ingestion/simulate.py)
instead of polling GitHub/npm/pypi/HN. Network-readiness wait kept even though
this no longer calls the internet — harmless, and this file stays the single
Task Scheduler entry point so the registered task doesn't need re-creating.

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

from datetime import date

from ingestion import db
from ingestion.backup import backup_db
from ingestion.simulate import bootstrap, simulate_day

# Kept from the GitHub-polling era in case a future source needs the network
# again — harmless no-op now, the generator itself makes no network calls.
NETWORK_CHECK_HOST = "api.github.com"
NETWORK_WAIT_ATTEMPTS = 3
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
    con = db.get_connection()
    try:
        bootstrap(con)
        simulate_day(con, date.today())
        backup_db(con)
        logger.info("daily poll done")
    finally:
        con.close()


if __name__ == "__main__":
    main()
