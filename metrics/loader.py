"""Loads and validates metrics/*.yaml — the semantic layer the agent reads
instead of raw schema (CLAUDE.md constraint 2). Fails loudly on a malformed
definition rather than silently skipping it.

This module only loads and validates. Turning a Metric into executable SQL is
the agent's job (Phase 3), not this one — see CLAUDE.md build order.
"""

from pathlib import Path
from typing import Literal, Optional

import yaml
from pydantic import BaseModel, Field, model_validator

METRICS_DIR = Path(__file__).resolve().parent


class Metric(BaseModel):
    name: str
    description: str = Field(min_length=1)
    source: str = Field(min_length=1, description="Base table in the DuckDB schema")
    join: Optional[str] = Field(default=None, description="JOIN clause(s) appended after FROM source")
    time_column: Optional[str] = Field(
        default=None, description="Column (possibly table-qualified) used for grain grouping; required when grain='day'"
    )
    aggregation: Literal["count", "sum", "avg", "min", "max"] = "sum"
    expression: Optional[str] = Field(default=None, description="Column or SQL expression to aggregate")
    filter: Optional[str] = Field(default=None, description="SQL WHERE-clause fragment")
    grain: Literal["day", "current"] = Field(
        default="day", description="'day' = grouped time series; 'current' = single live aggregate, no time bucket"
    )
    dimensions: list[str] = Field(
        default_factory=list,
        description="Governed, table-qualified columns (reachable via `join`) the agent may group this metric by. Never an arbitrary column outside this list.",
    )
    note: Optional[str] = None

    @model_validator(mode="after")
    def _expression_required_unless_count(self) -> "Metric":
        if self.aggregation != "count" and not self.expression:
            raise ValueError(
                f"metric '{self.name}': aggregation '{self.aggregation}' requires an `expression`"
            )
        return self

    @model_validator(mode="after")
    def _time_column_required_for_day_grain(self) -> "Metric":
        if self.grain == "day" and not self.time_column:
            raise ValueError(f"metric '{self.name}': grain 'day' requires a `time_column`")
        return self


def load_metrics(directory: Path = METRICS_DIR) -> dict[str, Metric]:
    """Loads every metrics/*.yaml, validates each definition, and returns
    {name: Metric}. Raises on a malformed definition or a name collision
    across files — never skips one silently."""
    metrics: dict[str, Metric] = {}

    for path in sorted(directory.glob("*.yaml")):
        with open(path) as f:
            doc = yaml.safe_load(f) or {}

        raw_metrics = doc.get("metrics")
        if not isinstance(raw_metrics, dict):
            raise ValueError(f"{path}: expected a top-level `metrics:` mapping")

        for name, fields in raw_metrics.items():
            if name in metrics:
                raise ValueError(f"{path}: duplicate metric name '{name}' (already defined elsewhere)")
            try:
                metrics[name] = Metric(name=name, **fields)
            except TypeError as e:
                raise ValueError(f"{path}: metric '{name}' is malformed: {e}") from e

    return metrics


if __name__ == "__main__":
    loaded = load_metrics()
    print(f"loaded {len(loaded)} metrics:")
    for name, m in sorted(loaded.items()):
        dims = f" dims={m.dimensions}" if m.dimensions else ""
        print(f"  {name:28} {m.source:18} grain={m.grain}{dims}")
