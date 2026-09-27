#!/usr/bin/env python3
"""PostToolUse(Agent): mark the subgoal done and keep a short excerpt of its result."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import jevlib  # noqa: E402


def main() -> None:
    data = jevlib.read_input()
    resp = data.get("tool_response") or {}
    registry = jevlib.state_read("subgoals.json", {})
    key = data.get("tool_use_id")
    if key in registry:
        text = " ".join(b.get("text", "") for b in resp.get("content", []) if isinstance(b, dict))
        registry[key]["status"] = "done" if resp.get("status") == "completed" else "running"
        registry[key]["result"] = text[:600]
        registry[key]["model"] = resp.get("resolvedModel")
        jevlib.state_write("subgoals.json", registry)
    jevlib.emit(None)


if __name__ == "__main__":
    jevlib.guard("agent_done", main)
