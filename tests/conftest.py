import pytest
from langgraph.checkpoint.memory import MemorySaver

from agent import graph


@pytest.fixture(autouse=True)
def in_memory_agent_checkpointer(monkeypatch):
    """The real app persists agent context to data/checkpoints.sqlite3. Tests
    reuse fixed thread_ids ("test-continuation", ...), so a persistent saver
    would leak one run's turns into the next run's "prior turn" context.
    Each test gets a fresh in-memory graph instead."""
    monkeypatch.setattr(graph, "_GRAPH", graph.build_graph(checkpointer=MemorySaver()))
