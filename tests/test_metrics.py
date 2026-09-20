"""Tests for the semantic layer (CLAUDE.md conventions: "Tests for the
validation layer and metric loading at minimum").

The compiles-check queries the live DuckDB schema rather than a mock — the
point is to catch a metric (or a declared dimension) referencing a column or
table that doesn't actually exist, which a pure YAML-shape test can't.
"""

from pathlib import Path

import pytest

from ingestion.db import get_connection
from metrics.loader import Metric, load_metrics

METRICS_DIR = Path(__file__).resolve().parent.parent / "metrics"


def test_loads_between_8_and_12_metrics():
    metrics = load_metrics()
    assert 8 <= len(metrics) <= 12, f"expected 8-12 metrics per CLAUDE.md target, got {len(metrics)}"


def test_no_duplicate_metric_names(tmp_path):
    (tmp_path / "a.yaml").write_text("metrics:\n  dup:\n    description: a\n    source: x\n    time_column: t\n    aggregation: count\n")
    (tmp_path / "b.yaml").write_text("metrics:\n  dup:\n    description: b\n    source: y\n    time_column: t\n    aggregation: count\n")
    with pytest.raises(ValueError, match="duplicate metric name"):
        load_metrics(tmp_path)


def test_non_count_aggregation_requires_expression(tmp_path):
    (tmp_path / "bad.yaml").write_text(
        "metrics:\n  broken:\n    description: bad\n    source: x\n    time_column: t\n    aggregation: sum\n"
    )
    with pytest.raises(ValueError, match="requires an `expression`"):
        load_metrics(tmp_path)


def test_day_grain_requires_time_column(tmp_path):
    (tmp_path / "bad.yaml").write_text(
        "metrics:\n  broken:\n    description: bad\n    source: x\n    aggregation: count\n    grain: day\n"
    )
    with pytest.raises(ValueError, match="requires a `time_column`"):
        load_metrics(tmp_path)


def test_current_grain_does_not_require_time_column(tmp_path):
    (tmp_path / "ok.yaml").write_text(
        "metrics:\n  fine:\n    description: ok\n    source: x\n    aggregation: count\n    grain: current\n"
    )
    metrics = load_metrics(tmp_path)
    assert metrics["fine"].time_column is None


def test_malformed_definition_fails_loudly(tmp_path):
    (tmp_path / "bad.yaml").write_text(
        "metrics:\n  broken:\n    description: bad\n    source: x\n    time_column: t\n    aggregation: not_a_real_aggregation\n    expression: y\n"
    )
    with pytest.raises(ValueError):
        load_metrics(tmp_path)


def test_missing_metrics_key_fails_loudly(tmp_path):
    (tmp_path / "bad.yaml").write_text("not_metrics: {}\n")
    with pytest.raises(ValueError, match="expected a top-level"):
        load_metrics(tmp_path)


@pytest.fixture(scope="module")
def con():
    connection = get_connection()
    yield connection
    connection.close()


@pytest.fixture(scope="module")
def metrics() -> dict[str, Metric]:
    return load_metrics(METRICS_DIR)


def _base_sql(m: Metric) -> str:
    select_expr = m.expression if m.expression else "*"
    sql = f"SELECT {select_expr}"
    if m.time_column:
        sql += f", {m.time_column}"
    sql += f" FROM {m.source}"
    if m.join:
        sql += f" {m.join}"
    if m.filter:
        sql += f" WHERE {m.filter}"
    return sql + " LIMIT 0"


def test_every_metric_compiles_against_the_live_schema(con, metrics):
    """Every metric's source/join/expression/filter/time_column must compile
    against the real schema — a bare SELECT with LIMIT 0, no data required."""
    for name, m in metrics.items():
        sql = _base_sql(m)
        try:
            con.execute(sql)
        except Exception as e:
            pytest.fail(f"metric '{name}' does not compile against the live schema: {sql!r}\n{e}")


def test_every_declared_dimension_compiles(con, metrics):
    """Every dimension a metric declares itself sliceable-by must also be a
    real, reachable column via that metric's `join` — otherwise the agent
    (Phase 3) would be offering the user a slice that doesn't actually exist."""
    for name, m in metrics.items():
        for dim in m.dimensions:
            sql = f"SELECT {dim} FROM {m.source}"
            if m.join:
                sql += f" {m.join}"
            sql += " LIMIT 0"
            try:
                con.execute(sql)
            except Exception as e:
                pytest.fail(f"metric '{name}' declares dimension '{dim}' that does not compile: {sql!r}\n{e}")
