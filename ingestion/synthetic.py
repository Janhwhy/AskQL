"""Synthetic dimensions — customer names, regions, reps, plan tiers.

CLAUDE.md: "generated once, then frozen," fixed seed so they're stable across
restarts. These are dimensions for grouping, never metrics — nobody checks
whether "Acme Corp" is real, but the revenue/usage numbers it's joined against
must stay real (see ingestion/config.py RATE_PER_DOWNLOAD).

Run once (safe to rerun — no-ops if already populated):
    python -m ingestion.synthetic
"""

import random
from datetime import date, timedelta

from faker import Faker

from . import db

SEED = 42
REGIONS = ["North America", "EMEA", "APAC", "LATAM"]
PLAN_TIERS = ["Free", "Starter", "Growth", "Enterprise"]
PLAN_WEIGHTS = [0.45, 0.30, 0.18, 0.07]  # funnel shape — most customers on low tiers
N_REPS = 8
N_CUSTOMERS = 60
SIGNUP_WINDOW_DAYS = 548  # matches the npm backfill window — plausible company age


def generate() -> None:
    con = db.get_connection()
    if con.execute("SELECT count(*) FROM customers").fetchone()[0] > 0:
        print("synthetic dimensions already populated, skipping")
        con.close()
        return

    fake = Faker()
    fake.seed_instance(SEED)
    rnd = random.Random(SEED)

    reps = []
    for rep_id in range(1, N_REPS + 1):
        name = fake.name()
        region = rnd.choice(REGIONS)
        reps.append((rep_id, name, region))
        con.execute("INSERT INTO sales_reps VALUES (?, ?, ?)", [rep_id, name, region])

    today = date.today()
    for customer_id in range(1, N_CUSTOMERS + 1):
        name = fake.company()
        region = rnd.choice(REGIONS)
        plan_tier = rnd.choices(PLAN_TIERS, weights=PLAN_WEIGHTS, k=1)[0]
        rep_id = rnd.choice([r[0] for r in reps if r[2] == region] or [r[0] for r in reps])
        signed_up_at = today - timedelta(days=rnd.randint(0, SIGNUP_WINDOW_DAYS))
        con.execute(
            "INSERT INTO customers VALUES (?, ?, ?, ?, ?, ?)",
            [customer_id, name, region, plan_tier, rep_id, signed_up_at],
        )

    print(f"generated {N_REPS} reps, {N_CUSTOMERS} customers")
    con.close()


if __name__ == "__main__":
    generate()
