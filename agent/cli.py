"""Terminal test harness for the Phase 4 agent. CLAUDE.md (Phase 3, still the
right bar): "Ask ten questions; the failures define the next phase." Extended
here to also exercise Phase 4's new nodes explicitly: a line-chart trend, a
bar-chart breakdown, a kpi single-value, and two genuinely ambiguous
questions each followed by a scripted clarification (proving the
"remembers the answer for the session" behavior, not just the initial ask).

Run:
    python -m agent.cli
"""

import json
import sys
import uuid

from dotenv import load_dotenv

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

load_dotenv()

from .graph import ask  # noqa: E402  (after load_dotenv, needs GEMINI_API_KEY present)

# Each item is either a single question, or (question, clarification_answer)
# for a scenario expected to trigger the ambiguity node on the first turn.
SCENARIOS = [
    "What was total revenue yesterday?",
    "How many new customers signed up in the last 7 days?",
    "What's the support ticket backlog right now?",
    "Show revenue by region for the last 30 days.",
    "How many customers have churned in total?",
    "What's the average deal size this month?",
    "Break down support tickets opened by product category, last 30 days.",
    "What's the average resolution time for support tickets?",
    "How many active customers do we have right now, by plan tier?",
    "Show me daily revenue for the last 14 days.",  # expects a line chart
    ("How's support doing?", "tickets opened"),  # expects AMBIGUOUS, then resolves
    ("Tell me about our customers.", "how many are active"),  # expects AMBIGUOUS, then resolves
    "What's the weather like today?",  # deliberately unanswerable — no metric for this
]


def _run_single(question: str) -> dict:
    return ask(question)


def _run_ambiguous(question: str, clarification: str) -> dict:
    thread_id = str(uuid.uuid4())
    first = ask(question, thread_id=thread_id)
    print(f"    -> ambiguity check: {json.dumps(first, indent=2, default=str)}")
    if "clarification_needed" not in first:
        print("    !! expected AMBIGUOUS sentinel, didn't get one")
        return first
    print(f"    -> clarifying: {clarification!r}")
    return ask(None, thread_id=thread_id, clarification_answer=clarification)


def main() -> None:
    results = []
    for i, scenario in enumerate(SCENARIOS, 1):
        if isinstance(scenario, tuple):
            question, clarification = scenario
            print(f"\n[{i}/{len(SCENARIOS)}] {question}  (expect ambiguity -> {clarification!r})")
            try:
                result = _run_ambiguous(question, clarification)
            except Exception as e:
                result = {"question": question, "sql": None, "error": f"unhandled exception: {e}"}
        else:
            question = scenario
            print(f"\n[{i}/{len(SCENARIOS)}] {question}")
            try:
                result = _run_single(question)
            except Exception as e:
                result = {"question": question, "sql": None, "error": f"unhandled exception: {e}"}
        results.append(result)
        print(json.dumps(result, indent=2, default=str))

    # A populated "error" is only a real failure if nothing else useful came
    # of it — a genuine NO_METRIC refusal or a still-pending clarification is
    # correct behavior. An unhandled exception (network error, crash) is NOT
    # a legitimate refusal even though it also has sql=None — don't let it
    # silently count as a pass.
    def _behaved_correctly(r: dict) -> bool:
        if "rows" in r or "clarification_needed" in r:
            return True
        if r.get("sql") is None and r.get("error"):
            return not r["error"].startswith("unhandled exception:")
        return False

    n_ok = sum(1 for r in results if _behaved_correctly(r))
    print(f"\n{'=' * 60}\n{n_ok}/{len(results)} behaved correctly (answered, refused, or asked)")


if __name__ == "__main__":
    main()
