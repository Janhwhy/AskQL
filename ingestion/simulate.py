"""Daily company-data generator for Northbeam (see ingestion/company.py).

Everything is a deterministic function of (entity, product/day, index) via
`_rng()` — never a bare `random()` call. Same call always produces the same
row, so regenerating from scratch reproduces identical history, and running
"today" twice is a safe no-op (simulate_day checks first).

Two entry points:
    backfill(con, start, end)   — one call per day in [start, end], instant
    simulate_day(con, target)   — one day, used by the daily scheduler job
"""

import random
from datetime import date, timedelta

from faker import Faker

from . import company, db

WEEKDAY_FACTOR = [1.05, 1.08, 1.10, 1.08, 0.95, 0.55, 0.45]  # Mon..Sun, B2B weekend dip
ANOMALY_CHANCE = 0.02
ANOMALY_MULTIPLIERS = [0.4, 0.5, 1.8, 2.2]  # rare dip or spike day
NEW_CUSTOMER_CHANCE = 0.02  # fraction of sales that go to a brand-new customer
TICKET_RESOLVE_CHANCE = 0.30  # fraction of open tickets closed each day
CHURN_CHANCE_PER_DAY = 0.0005  # per active customer, per day


def _rng(*parts) -> random.Random:
    return random.Random("|".join(str(p) for p in parts) + f"|{company.SEED}")


def _noise(rng: random.Random, spread: float = 0.15) -> float:
    return 1 + rng.uniform(-spread, spread)


def _anomaly(rng: random.Random) -> float:
    return rng.choice(ANOMALY_MULTIPLIERS) if rng.random() < ANOMALY_CHANCE else 1.0


def bootstrap(con) -> None:
    """One-time setup: products, reps, founding customers. Safe to rerun."""
    if con.execute("SELECT count(*) FROM products").fetchone()[0] == 0:
        for p in company.PRODUCTS:
            con.execute(
                "INSERT INTO products VALUES (?, ?, ?, ?, ?, ?)",
                [p["product_id"], p["name"], p["category"], p["price"], p["base_daily_sales"], p["growth_rate"]],
            )
        print(f"seeded {len(company.PRODUCTS)} products")

    if con.execute("SELECT count(*) FROM sales_reps").fetchone()[0] == 0:
        fake = Faker()
        fake.seed_instance(company.SEED)
        rnd = random.Random(company.SEED)
        for rep_id in range(1, company.N_REPS + 1):
            region = company.REGIONS[(rep_id - 1) % len(company.REGIONS)]
            con.execute("INSERT INTO sales_reps VALUES (?, ?, ?)", [rep_id, fake.name(), region])
        print(f"seeded {company.N_REPS} reps")

    if con.execute("SELECT count(*) FROM customers").fetchone()[0] == 0:
        fake = Faker()
        fake.seed_instance(company.SEED + 1)  # distinct stream from reps
        rnd = random.Random(company.SEED + 1)
        reps = con.execute("SELECT rep_id, region FROM sales_reps").fetchall()
        for customer_id in range(1, company.N_FOUNDING_CUSTOMERS + 1):
            region = rnd.choice(company.REGIONS)
            plan_tier = rnd.choices(company.PLAN_TIERS, weights=company.PLAN_WEIGHTS, k=1)[0]
            region_reps = [r for r, reg in reps if reg == region] or [r for r, _ in reps]
            rep_id = rnd.choice(region_reps)
            con.execute(
                "INSERT INTO customers VALUES (?, ?, ?, ?, ?, ?, ?)",
                [customer_id, fake.company(), region, plan_tier, rep_id, company.FOUNDED, None],
            )
        print(f"seeded {company.N_FOUNDING_CUSTOMERS} founding customers")


def _create_customer(con, rng: random.Random, target_date: date, reps_by_region: dict) -> tuple[int, str, int]:
    fake = Faker()
    fake.seed_instance(rng.random())
    region = rng.choice(company.REGIONS)
    plan_tier = rng.choices(company.PLAN_TIERS, weights=company.PLAN_WEIGHTS, k=1)[0]
    region_reps = reps_by_region.get(region) or [r for reps in reps_by_region.values() for r in reps]
    rep_id = rng.choice(region_reps)
    customer_id = con.execute("SELECT coalesce(max(customer_id), 0) + 1 FROM customers").fetchone()[0]
    con.execute(
        "INSERT INTO customers VALUES (?, ?, ?, ?, ?, ?, ?)",
        [customer_id, fake.company(), region, plan_tier, rep_id, target_date, None],
    )
    return customer_id, region, rep_id


def simulate_day(con, target_date: date) -> None:
    if con.execute("SELECT 1 FROM sales WHERE date = ? LIMIT 1", [target_date]).fetchone():
        return  # already simulated — idempotent, safe to call twice

    day_index = (target_date - company.FOUNDED).days
    if day_index < 0:
        return

    reps = con.execute("SELECT rep_id, region FROM sales_reps").fetchall()
    reps_by_region: dict[str, list[int]] = {}
    for rep_id, region in reps:
        reps_by_region.setdefault(region, []).append(rep_id)

    active = con.execute(
        "SELECT customer_id, region, rep_id FROM customers "
        "WHERE signed_up_at <= ? AND (churned_at IS NULL OR churned_at > ?)",
        [target_date, target_date],
    ).fetchall()

    # Which customers have actually bought each product before today — tickets
    # for a product must scale with ITS OWN buyers, not the whole company's
    # active list, or every product looks equally (and unrealistically) loaded
    # regardless of how many customers actually use it.
    product_customers: dict[int, set[int]] = {}
    for product_id, customer_id in con.execute(
        "SELECT DISTINCT product_id, customer_id FROM sales WHERE date < ?", [target_date]
    ).fetchall():
        product_customers.setdefault(product_id, set()).add(customer_id)

    next_sale_id = con.execute("SELECT coalesce(max(sale_id), 0) FROM sales").fetchone()[0]
    next_ticket_id = con.execute("SELECT coalesce(max(ticket_id), 0) FROM support_tickets").fetchone()[0]
    sale_rows = []
    ticket_rows = []

    for product in company.PRODUCTS:
        product_id = product["product_id"]
        day_rng = _rng("sales-day", product_id, day_index)
        expected = (
            product["base_daily_sales"]
            * (1 + product["growth_rate"]) ** day_index
            * WEEKDAY_FACTOR[target_date.weekday()]
            * _noise(day_rng)
            * _anomaly(day_rng)
        )
        n_sales = max(0, round(expected))
        owners = product_customers.setdefault(product_id, set())

        for i in range(n_sales):
            row_rng = _rng("sale", product_id, day_index, i)
            if active and row_rng.random() > NEW_CUSTOMER_CHANCE:
                customer_id, region, rep_id = row_rng.choice(active)
            else:
                customer_id, region, rep_id = _create_customer(con, row_rng, target_date, reps_by_region)
                active.append((customer_id, region, rep_id))
            owners.add(customer_id)

            channel = row_rng.choices(company.CHANNELS, weights=company.CHANNEL_WEIGHTS, k=1)[0]
            quantity = row_rng.choice([1, 1, 1, 2, 3])
            amount = round(product["price"] * quantity * (1 + row_rng.uniform(-0.05, 0.05)), 2)
            next_sale_id += 1
            sale_rows.append((next_sale_id, target_date, product_id, customer_id, channel, quantity, amount))

        ticket_rng = _rng("tickets", product_id, day_index)
        ticket_rate = company.TICKET_RATE_BY_CATEGORY[product["category"]]
        n_tickets = round(len(owners) * ticket_rate * _noise(ticket_rng))
        owners_list = list(owners)
        for i in range(n_tickets):
            if not owners_list:
                break
            row_rng = _rng("ticket", product_id, day_index, i)
            customer_id = row_rng.choice(owners_list)
            next_ticket_id += 1
            ticket_rows.append((next_ticket_id, target_date, product_id, customer_id, target_date, "open"))

    if sale_rows:
        con.executemany(
            "INSERT INTO sales (sale_id, date, product_id, customer_id, channel, quantity, amount) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            sale_rows,
        )
    if ticket_rows:
        con.executemany(
            "INSERT INTO support_tickets (ticket_id, date, product_id, customer_id, opened_at, status) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            ticket_rows,
        )

    resolve_rng = _rng("resolve", day_index)
    open_tickets = con.execute(
        "SELECT ticket_id FROM support_tickets WHERE status = 'open' AND opened_at < ?", [target_date]
    ).fetchall()
    for (ticket_id,) in open_tickets:
        if resolve_rng.random() < TICKET_RESOLVE_CHANCE:
            con.execute(
                "UPDATE support_tickets SET status = 'closed', closed_at = ? WHERE ticket_id = ?",
                [target_date, ticket_id],
            )

    churn_rng = _rng("churn", day_index)
    for customer_id, _, _ in active:
        if churn_rng.random() < CHURN_CHANCE_PER_DAY:
            con.execute("UPDATE customers SET churned_at = ? WHERE customer_id = ?", [target_date, customer_id])


def backfill(con, start: date, end: date) -> None:
    bootstrap(con)
    current = start
    while current <= end:
        simulate_day(con, current)
        current += timedelta(days=1)
