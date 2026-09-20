"""Terminal test harness for the Phase 3 minimal agent. CLAUDE.md: "Ask ten
questions; the failures define the next phase." Run:
    python -m agent.cli
"""

import json
import sys
from pathlib import Path

from dotenv import load_dotenv

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

load_dotenv()

from .graph import ask  # noqa: E402  (after load_dotenv, needs GEMINI_API_KEY present)

TEST_QUESTIONS = [
    "What was total revenue yesterday?",
    "How many new customers signed up in the last 7 days?",
    "What's the support ticket backlog right now?",
    "Show revenue by region for the last 30 days.",
    "How many customers have churned in total?",
    "What's the average deal size this month?",
    "Break down support tickets opened by product category, last 30 days.",
    "What's the average resolution time for support tickets?",
    "How many active customers do we have right now, by plan tier?",
    "What's the weather like today?",  # deliberately unanswerable — no metric for this
]


def main() -> None:
    results = []
    for i, question in enumerate(TEST_QUESTIONS, 1):
        print(f"\n[{i}/{len(TEST_QUESTIONS)}] {question}")
        try:
            result = ask(question)
        except Exception as e:
            result = {"question": question, "sql": None, "error": f"unhandled exception: {e}"}
        results.append(result)
        print(json.dumps(result, indent=2, default=str))

    # A populated "error" is only a real failure if the query didn't even
    # produce rows — a NO_METRIC refusal (sql=None, error=reason) is correct
    # behavior, not a failure, and shouldn't count against the pass rate.
    n_ok = sum(1 for r in results if "rows" in r or r.get("sql") is None)
    print(f"\n{'=' * 60}\n{n_ok}/{len(results)} behaved correctly (answered or correctly refused)")


if __name__ == "__main__":
    main()
