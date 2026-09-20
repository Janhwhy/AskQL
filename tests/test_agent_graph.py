"""Control-flow tests for the Phase 4 agent graph (agent/graph.py). These
mock agent.graph.generate (the LLM call) so they're deterministic and don't
need real credentials — they test the retry/ambiguity WIRING, not the LLM's
actual SQL-writing ability (that's judged by eyeballing live runs, per the
Phase 4 plan's verification section).
"""

import agent.graph as graph_module
from agent.graph import _resolve_clarification, ask
from metrics.loader import load_metrics


def test_self_correction_retries_once_then_succeeds(monkeypatch):
    calls = []

    def fake_generate(prompt: str) -> str:
        calls.append(prompt)
        if len(calls) == 1:
            return "SELECT * FROM totally_fake_table_that_does_not_exist"
        return "SELECT COUNT(*) FROM customers"

    monkeypatch.setattr(graph_module, "generate", fake_generate)

    result = ask("how many customers do we have", thread_id="test-retry-success")

    assert result["error"] is None if "error" in result else True
    assert "rows" in result
    assert result["retries"] == 1
    # 3 calls: initial generate_sql, correct_sql, then narrate (also an LLM call)
    assert len(calls) == 3
    assert "totally_fake_table" in calls[1]  # correction prompt includes the failure


def test_gives_up_after_one_retry(monkeypatch):
    calls = []

    def always_broken(prompt: str) -> str:
        calls.append(prompt)
        return "SELECT * FROM still_fake_table"

    monkeypatch.setattr(graph_module, "generate", always_broken)

    result = ask("how many customers do we have", thread_id="test-retry-giveup")

    assert result.get("rows") is None
    assert result["error"] is not None
    assert "still_fake_table" in result["error"] or "execution failed" in result["error"]
    assert len(calls) == 2  # one initial attempt + exactly one correction, never more


def test_ambiguity_round_trip_remembers_clarification(monkeypatch):
    prompts = []

    def fake_generate(prompt: str) -> str:
        prompts.append(prompt)
        if len(prompts) == 1:
            return "AMBIGUOUS: which support metric? | support_tickets_opened, support_tickets_resolved"
        return "SELECT COUNT(*) FROM support_tickets"

    monkeypatch.setattr(graph_module, "generate", fake_generate)

    first = ask("how's support doing?", thread_id="test-ambiguity")
    assert first["sql"] is None
    assert "clarification_needed" in first
    assert set(first["candidates"]) == {"support_tickets_opened", "support_tickets_resolved"}
    assert len(prompts) == 1  # no DB hit, no wasted second call yet

    second = ask(None, thread_id="test-ambiguity", clarification_answer="tickets opened")
    assert second["question"] == "how's support doing?"  # original question, not the answer text
    assert "rows" in second
    # 3 prompts total: initial (ambiguous), regenerate (resolved), then narrate
    assert len(prompts) == 3
    # The resolved prompt must be narrowed to ONLY the matched metric -- not
    # just "contains the answer text somewhere" (that previously passed by
    # coincidence, via the metric's own description containing the phrase,
    # and would NOT have caught the real bug this once had: the
    # clarification_answer field being silently dropped because it wasn't
    # declared in AgentState, which LangGraph filters invoke() input
    # against. Checking the OTHER candidate is absent is the real proof the
    # narrowing happened, not a lucky substring match.)
    assert "support_tickets_opened" in prompts[1]
    assert "support_tickets_resolved" not in prompts[1]


def test_resolve_clarification_matches_correct_candidate():
    """Unit test of the deterministic resolver in isolation -- this is what
    replaced asking the LLM to re-correlate its own prior question, after
    live testing showed a 7B local model reliably failed at that and just
    re-asked the same clarifying question instead of resolving it."""
    metrics = load_metrics()
    candidates = ["support_tickets_opened", "support_tickets_resolved", "support_backlog"]

    assert _resolve_clarification("tickets opened", candidates, metrics) == "support_tickets_opened"
    assert _resolve_clarification("resolved ones", candidates, metrics) == "support_tickets_resolved"
    assert _resolve_clarification("the backlog", candidates, metrics) == "support_backlog"
    assert _resolve_clarification("xyzzy nonsense", candidates, metrics) is None
