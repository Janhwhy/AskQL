"""Tracked repos/packages and polling config for Phase 1 ingestion.

Selection validated against spec section 3.6's events/hour ranking script
(2026-09-19): all four langchain-ai repos land between 3.7-5.4 events/hr with
a varied event mix (Watch, Issues, PullRequest, IssueComment), comfortably
above the ~1/hr floor. langchain-ai is used as the "company" org.
"""

import os

TRACKED_REPOS = [
    "langchain-ai/langchain",
    "langchain-ai/langgraph",
    "langchain-ai/langsmith-sdk",
    "langchain-ai/langchainjs",
]

NPM_PACKAGES = [
    "langchain",
    "@langchain/langgraph",
]

PYPI_PACKAGES = [
    "langchain",
    "langgraph",
]

# HN has no keyword-search endpoint on the firebaseio.com/v0 API used elsewhere
# in this project, so mentions are pulled from the Algolia HN Search API
# (hn.algolia.com), which is also zero-auth and is the standard way to query HN
# by keyword.
HN_QUERIES = [
    "langchain",
]

POLL_INTERVAL_SECONDS = int(os.environ.get("POLL_INTERVAL_SECONDS") or "1800")

# Modeled revenue = downloads * RATE_PER_DOWNLOAD (spec section 6). Real combined
# npm+pypi volume for these packages is ~8.3M downloads/day — raw installs
# include CI/mirrors/Docker rebuilds, not unique paying customers, so pricing
# it like a direct per-download fee (the spec's own example, $0.02) would model
# ~$60M ARR, absurd for a fictional startup. $0.002/download (~$2 per 1,000)
# lands around $16k/day (~$6M ARR) — a believable Series A/B SaaS scale for a
# demo. Provisional; revisit once real volumes are known post-backfill.
RATE_PER_DOWNLOAD = 0.002
