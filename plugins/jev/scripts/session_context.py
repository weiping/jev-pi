#!/usr/bin/env python3
"""SessionStart(compact): re-inject the pinned conditional context after a compaction."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import jevlib  # noqa: E402


def main() -> None:
    jevlib.read_input()
    pinned = jevlib.state_read("pinned_context.md", "")
    if pinned and jevlib.mode() == "enforce":
        jevlib.emit({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": pinned}})
    jevlib.emit(None)


if __name__ == "__main__":
    jevlib.guard("session_context", main)
