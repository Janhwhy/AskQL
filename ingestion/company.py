"""Static definition of the simulated company — Northbeam.

2026-09-20 pivot: replaces the GitHub/npm/pypi ingestion (ingestion/sources/)
as the primary data source. That approach hit real limits (rate limits,
platform-side endpoint blocks, exactly one real "product") that fought the
actual goal — an instant chatbot dashboard over rich, varied business data.
Fully synthetic now, but deterministic-seeded (never bare random()) so
history is reproducible and trends/anomalies mean something when charted.

Everything in this file is frozen — generated once from SEED, same output
every import. Actual day-to-day data growth (sales, tickets, new customers)
lives in ingestion/simulate.py, which draws its own per-day seeded random
numbers, never touches this module's RNG state.
"""

import random
from datetime import date

SEED = 42
COMPANY_NAME = "Northbeam"
FOUNDED = date(2025, 1, 1)  # day_index 0 for the growth/backfill formulas

REGIONS = ["North America", "EMEA", "APAC", "LATAM"]
CHANNELS = ["Organic", "Paid Ads", "Partner", "Outbound"]
CHANNEL_WEIGHTS = [0.50, 0.25, 0.15, 0.10]
PLAN_TIERS = ["Free", "Starter", "Growth", "Enterprise"]
PLAN_WEIGHTS = [0.45, 0.30, 0.18, 0.07]

N_REPS = 12
N_FOUNDING_CUSTOMERS = 20  # seeded on day 0 so there's a base to sell to immediately

CATEGORIES = {
    "Analytics & BI": ["Insight Studio", "MetricFlow", "PulseBoard", "QueryLake", "ReportForge"],
    "Developer Tools": ["CodeRelay", "APIForge", "DevBridge", "ScriptHive", "BuildPipe"],
    "Infrastructure & Hosting": ["CloudAnchor", "EdgeStack", "ScaleGrid", "NodeHarbor", "StorVault"],
    "Security & Compliance": ["GuardRail", "AuditLens", "ShieldSync", "ComplyTrack", "VaultKey"],
    "Collaboration & Productivity": ["TeamFlow", "DocSpace", "SyncBoard", "TaskRiver"],
}

# price / daily-sales-volume / per-day growth-rate ranges per category.
# Infra & Security: higher price, slower volume, slower growth (typical
# enterprise B2B). Dev tools & Collab: cheaper, higher volume, faster growth.
CATEGORY_PROFILE = {
    "Analytics & BI":                {"price": (49, 299),   "daily_sales": (1, 4), "growth": (0.0003, 0.0009)},
    "Developer Tools":               {"price": (19, 149),   "daily_sales": (2, 6), "growth": (0.0004, 0.0012)},
    "Infrastructure & Hosting":      {"price": (199, 1999), "daily_sales": (0, 2), "growth": (0.0002, 0.0007)},
    "Security & Compliance":         {"price": (299, 2499), "daily_sales": (0, 2), "growth": (0.0002, 0.0006)},
    "Collaboration & Productivity":  {"price": (15, 99),    "daily_sales": (2, 7), "growth": (0.0005, 0.0014)},
}

# support tickets per active customer per day, by category — infra/security
# customers file more tickets (higher stakes), collab tools file fewer.
TICKET_RATE_BY_CATEGORY = {
    "Analytics & BI": 0.015,
    "Developer Tools": 0.02,
    "Infrastructure & Hosting": 0.035,
    "Security & Compliance": 0.03,
    "Collaboration & Productivity": 0.01,
}


def build_products() -> list[dict]:
    """Frozen product list: id, name, category, price, base_daily_sales,
    growth_rate. Deterministic from SEED — identical list every call."""
    rnd = random.Random(SEED)
    products = []
    product_id = 1
    for category, names in CATEGORIES.items():
        profile = CATEGORY_PROFILE[category]
        for name in names:
            products.append({
                "product_id": product_id,
                "name": name,
                "category": category,
                "price": round(rnd.uniform(*profile["price"]), 2),
                "base_daily_sales": rnd.uniform(*profile["daily_sales"]),
                "growth_rate": rnd.uniform(*profile["growth"]),
            })
            product_id += 1
    return products


PRODUCTS = build_products()
