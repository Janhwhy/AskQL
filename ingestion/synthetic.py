"""PARKED, unused as of 2026-09-20 — superseded by ingestion/company.py
(product/dimension definitions) and ingestion/simulate.py (bootstrap() does
what generate() did here, plus products/reps/founding customers in one
place). Left here, not deleted; nothing imports this anymore.

Synthetic dimensions — customer names, regions, reps, plan tiers.

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

# Relative "worth" per tier — a Free customer contributes nothing to a revenue
# split, Enterprise contributes 15x a Starter customer. Used only to turn the
# frozen customer list into frozen region_weights (below), never to invent a
# metric on its own. Rough SaaS-typical ratios, not derived from anything.
TIER_VALUE = {"Free": 0, "Starter": 1, "Growth": 4, "Enterprise": 15}

# Sales channel split — no real signal exists for this anywhere (same as
# region), so this is a flat business assumption, not derived from the
# customer table. Documented and frozen exactly like RATE_PER_DOWNLOAD in
# config.py: a stated modeling choice, not a measured fact. Must sum to 1.0.
CHANNEL_WEIGHTS = {
    "Organic": 0.50,
    "Paid Ads": 0.25,
    "Partner": 0.15,
    "Outbound": 0.10,
}


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


def compute_region_weights() -> None:
    """Derives a frozen revenue share per region from the (also frozen)
    customer list, so a real total can be honestly split by region:
    revenue_in_region = real_total_revenue * region_weights.weight.

    Deterministic given the frozen customers table — no random() at query
    time, satisfies the "synthetic metrics derive from real data" rule the
    same way the revenue formula does, just one layer removed.

    Safe to rerun (no-ops if already populated).
    """
    con = db.get_connection()
    if con.execute("SELECT count(*) FROM region_weights").fetchone()[0] > 0:
        print("region weights already computed, skipping")
        con.close()
        return

    rows = con.execute("SELECT region, plan_tier FROM customers").fetchall()
    totals = {region: 0.0 for region in REGIONS}
    for region, plan_tier in rows:
        totals[region] += TIER_VALUE[plan_tier]

    grand_total = sum(totals.values()) or 1.0
    for region, value in totals.items():
        con.execute("INSERT INTO region_weights VALUES (?, ?)", [region, value / grand_total])

    print("region weights:", {r: round(v / grand_total, 3) for r, v in totals.items()})
    con.close()


def compute_channel_weights() -> None:
    """Writes the flat CHANNEL_WEIGHTS assumption into the DB so metric
    definitions can join against it the same way as region_weights, even
    though (unlike region) it isn't derived from the customer table — no
    real or frozen-synthetic signal exists to derive it from. Safe to rerun.
    """
    con = db.get_connection()
    if con.execute("SELECT count(*) FROM channel_weights").fetchone()[0] > 0:
        print("channel weights already computed, skipping")
        con.close()
        return
    total = sum(CHANNEL_WEIGHTS.values())
    for channel, weight in CHANNEL_WEIGHTS.items():
        con.execute("INSERT INTO channel_weights VALUES (?, ?)", [channel, weight / total])
    print("channel weights:", CHANNEL_WEIGHTS)
    con.close()


if __name__ == "__main__":
    generate()
    compute_region_weights()
    compute_channel_weights()
