"""Control-flow tests for the Phase 4 agent graph (agent/graph.py). These
mock agent.graph.generate (the LLM call) so they're deterministic and don't
need real credentials — they test the retry/ambiguity WIRING, not the LLM's
actual SQL-writing ability (that's judged by eyeballing live runs, per the
Phase 4 plan's verification section).
"""

import agent.graph as graph_module
from agent.graph import _is_chart_followup, _resolve_clarification, ask
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


def test_is_chart_followup_matches_narrow_chart_type_requests():
    for phrasing in [
        "now give it as a table",
        "show as bar chart",
        "make it a pie chart",
        "table",
        "as a line chart",
        "switch to table view",
        "convert to pie",
        "now pie again",
    ]:
        assert _is_chart_followup(phrasing), phrasing


def test_is_chart_followup_rejects_questions_with_real_content():
    """The whole point of this being a narrow regex: anything with actual
    new semantic content must fall through to a fresh question, never be
    misread as "just a chart-type change" — a false positive here would
    silently answer the wrong question."""
    for phrasing in [
        "give me pie chart for top 5 products by sales",
        "show revenue by region as a table",
        "what's the support backlog",
        "",
        None,
    ]:
        assert not _is_chart_followup(phrasing), phrasing


def test_chart_followup_reuses_prior_turn_without_requerying(monkeypatch):
    """End-to-end: ask a full question, then a narrow chart-type follow-up
    on the same thread — the follow-up must reuse the exact same SQL/rows
    (not regenerate them, which could silently drift to a different
    result) and only the chart decision should change."""
    calls = []

    def fake_generate(prompt: str) -> str:
        calls.append(prompt)
        return "SELECT region, SUM(amount) AS total FROM sales JOIN customers ON customers.customer_id = sales.customer_id GROUP BY region"

    monkeypatch.setattr(graph_module, "generate", fake_generate)

    first = ask("revenue by region as a pie chart", thread_id="test-chart-followup")
    assert first["chart"]["chart_type"] == "pie"
    calls_after_first = len(calls)
    assert calls_after_first >= 1  # generate_sql + narrate happened for real

    second = ask("now give it as a table", thread_id="test-chart-followup")
    assert second["chart"]["chart_type"] == "table"
    assert second["sql"] == first["sql"]
    assert second["rows"] == first["rows"]
    assert second["narration"] == first["narration"]
    assert len(calls) == calls_after_first  # no new LLM call at all for the follow-up

    # a second, different follow-up must still reuse the ORIGINAL data, not
    # something derived from the "table" turn
    third = ask("make it a bar chart", thread_id="test-chart-followup")
    assert third["chart"]["chart_type"] == "bar"
    assert third["sql"] == first["sql"]
    assert len(calls) == calls_after_first  # still no new LLM call


def test_continuation_question_gets_prior_turn_as_context(monkeypatch):
    """Real bug, caught live: "now the same for 7 days" after "daily
    revenue for the last 14 days" got answered with a DIFFERENT metric
    (units_sold instead of revenue) because generate_sql had zero memory
    of the previous turn for anything except the narrow chart-type-only
    follow-up path. This isn't a chart-type-only phrasing (doesn't match
    _is_chart_followup), so it must go through the real SQL-generation
    path — but that path must now be handed the previous question/SQL."""
    prompts = []

    def fake_generate(prompt: str) -> str:
        prompts.append(prompt)
        if len(prompts) == 1:
            return "SELECT date, SUM(sales.amount) FROM sales WHERE sales.date >= DATE '2026-09-21' - INTERVAL 14 DAY GROUP BY date"
        if len(prompts) == 2:
            # this is the narrate() call for turn 1
            return "Revenue trended up over the period."
        if len(prompts) == 3:
            # generate_sql for turn 2 -- assert BEFORE returning, so a
            # failure here points at the real cause, not a downstream one
            assert "now the same for 7 days" in prompt
            assert "Show me daily revenue for the last 14 days" in prompt, (
                "prior question missing from prompt -- continuation context wasn't wired in"
            )
            assert "INTERVAL 14 DAY" in prompt, "prior SQL missing from prompt"
            return "SELECT date, SUM(sales.amount) FROM sales WHERE sales.date >= DATE '2026-09-21' - INTERVAL 7 DAY GROUP BY date"
        return "Revenue trended up over the period."

    monkeypatch.setattr(graph_module, "generate", fake_generate)

    first = ask("Show me daily revenue for the last 14 days", thread_id="test-continuation")
    assert "rows" in first

    second = ask("now the same for 7 days", thread_id="test-continuation")
    assert "rows" in second
    assert "sales.amount" in second["sql"]  # stayed on revenue, didn't drift to another metric
    assert "7 DAY" in second["sql"]
