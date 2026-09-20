"""Serializes metrics/*.yaml into the only thing the LLM ever sees about the
database — CLAUDE.md constraint 2: the agent never sees raw schema. No table
lists, no column dumps. Just the governed metric definitions, verbatim.
"""

from metrics.loader import Metric


def metrics_context(metrics: dict[str, Metric]) -> str:
    lines = []
    for name, m in sorted(metrics.items()):
        lines.append(f"- {name}: {m.description}")
        lines.append(f"    source: {m.source}")
        if m.join:
            lines.append(f"    join: {m.join}")
        if m.expression:
            lines.append(f"    expression: {m.expression}")
        lines.append(f"    aggregation: {m.aggregation}")
        if m.filter:
            lines.append(f"    base filter (always applies): {m.filter}")
        if m.time_column:
            lines.append(f"    time_column: {m.time_column}")
        lines.append(f"    grain: {m.grain}")
        if m.dimensions:
            lines.append(f"    allowed group-by dimensions: {', '.join(m.dimensions)}")
        if m.note:
            lines.append(f"    note: {m.note.strip()}")
    return "\n".join(lines)


def clarifications_block(clarifications: dict[str, str]) -> str:
    """Renders session-remembered ambiguity resolutions for the prompt, so the
    agent doesn't re-ask about something the user already clarified this
    session (CLAUDE.md: the ambiguity node "remembers the answer for the
    session"). Empty string when nothing's been clarified yet."""
    if not clarifications:
        return ""
    lines = ["Already clarified earlier this session — do not ask about these again:"]
    for key, answer in clarifications.items():
        lines.append(f"- {key}: {answer}")
    return "\n".join(lines)
