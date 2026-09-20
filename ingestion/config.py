"""PARKED, unused as of 2026-09-20 — real-data ingestion (GitHub/npm/PyPI)
was scrapped in favor of a fully simulated company. See ingestion/company.py
for the config that's actually in use now. Left here, not deleted, in case
a real-data integration happens later; nothing imports this anymore.

Tracked repos/packages and polling config for the old Phase 1 ingestion.

Selection validated against spec section 3.6's events/hour ranking script
(2026-09-19): all four langchain-ai repos land between 3.7-5.4 events/hr with
a varied event mix (Watch, Issues, PullRequest, IssueComment), comfortably
above the ~1/hr floor. langchain-ai is used as the "company" org.

duckdb/duckdb added 2026-09-20 as a second, unrelated real product line, to
give the fictional company real multi-product variety instead of one repo
family under one label. Validated same way: 5.5 events/hr, mixed event types
(Watch/PR/Issue/Fork). See PRODUCT_CATALOG below for the name/category
mapping — the label is fictional, the underlying numbers are real.
"""

import os

TRACKED_REPOS = [
    "langchain-ai/langchain",
    "langchain-ai/langgraph",
    "langchain-ai/langsmith-sdk",
    "langchain-ai/langchainjs",
    "duckdb/duckdb",
]

NPM_PACKAGES = [
    "langchain",
    "@langchain/langgraph",
]

PYPI_PACKAGES = [
    "langchain",
    "langgraph",
    "duckdb",
]

# HN has no keyword-search endpoint on the firebaseio.com/v0 API used elsewhere
# in this project, so mentions are pulled from the Algolia HN Search API
# (hn.algolia.com), which is also zero-auth and is the standard way to query HN
# by keyword.
HN_QUERIES = [
    "langchain",
    "duckdb",
]

# Maps a real tracked source to a fictional product name + category. The
# ingestion tables (repo_snapshots.repo, npm_downloads.package, etc.) always
# keep the real, true source name — this dict is a label layer applied at
# query/metric time (Phase 2), never written into the raw tables. Multiple
# real repos/packages can share one fictional product (LangChain's 4 repos
# are all "LangChain Core" activity, just different surfaces of it).
PRODUCT_CATALOG = {
    "langchain-ai/langchain": ("LangChain Core", "AI Platform"),
    "langchain-ai/langgraph": ("LangGraph", "AI Platform"),
    "langchain-ai/langsmith-sdk": ("LangSmith SDK", "AI Platform"),
    "langchain-ai/langchainjs": ("LangChain Core", "AI Platform"),
    "langchain": ("LangChain Core", "AI Platform"),
    "@langchain/langgraph": ("LangGraph", "AI Platform"),
    "langgraph": ("LangGraph", "AI Platform"),
    "duckdb/duckdb": ("PulseDB", "Data Infrastructure"),
    "duckdb": ("PulseDB", "Data Infrastructure"),
}

POLL_INTERVAL_SECONDS = int(os.environ.get("POLL_INTERVAL_SECONDS") or "1800")

# Modeled revenue = downloads * RATE_PER_DOWNLOAD (spec section 6). Real combined
# npm+pypi volume for these packages is ~8.3M downloads/day — raw installs
# include CI/mirrors/Docker rebuilds, not unique paying customers, so pricing
# it like a direct per-download fee (the spec's own example, $0.02) would model
# ~$60M ARR, absurd for a fictional startup. $0.002/download (~$2 per 1,000)
# lands around $16k/day (~$6M ARR) — a believable Series A/B SaaS scale for a
# demo. Provisional; revisit once real volumes are known post-backfill.
RATE_PER_DOWNLOAD = 0.002
