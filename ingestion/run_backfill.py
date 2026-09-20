"""One-time historical backfill for the simulated company (Northbeam).

Generates every day from company.FOUNDED through yesterday in one pass —
instant, since each day is a deterministic formula, not a network call.

Run once (safe to rerun — simulate_day skips any day already present):
    python -m ingestion.run_backfill
"""

import sys
from datetime import date, timedelta

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from ingestion import company, db
from ingestion.simulate import backfill


def main() -> None:
    con = db.get_connection()
    end = date.today() - timedelta(days=1)
    backfill(con, company.FOUNDED, end)

    for table in ["products", "sales_reps", "customers", "sales", "support_tickets"]:
        count = con.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
        print(f"{table}: {count} rows")
    con.close()


if __name__ == "__main__":
    main()
