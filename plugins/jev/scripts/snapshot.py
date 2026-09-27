#!/usr/bin/env python3
"""Shared retrieval for read-only reviewers: rank changed files once, write one snapshot."""
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import jevlib  # noqa: E402
from typesafe_sdk import Score  # noqa: E402

base = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else "HEAD"


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=jevlib.PROJECT, capture_output=True, text=True).stdout


files = git("diff", "--name-only", base).split()
diff = git("diff", base)
if not files:
    print(f"No changes against {base}.")
    raise SystemExit
questions = {f"f{i}": Score(
    instructions=f"How important is it for a reviewer of `diff` to read file `{f}` in full?",
    criteria=["Not needed", "Skim the diff hunk only", "Read the whole file"]) for i, f in enumerate(files[:100])}
answers = jevlib.ask("snapshot", {"diff": diff[:60000]}, questions)
ranked = sorted(files[:100], key=lambda f: -answers[f"f{files.index(f)}"].score)
out = [f"# Change snapshot against {base}", "", "## Files by review priority", ""]
out += [f"- {f} (score {answers[f'f{files.index(f)}'].score:.2f})" for f in ranked]
out += ["", "## Diff", "", "```diff", diff[:60000], "```"]
jevlib.state_write("snapshot.md", "\n".join(out))
print(f"Snapshot written: {jevlib.STATE / 'snapshot.md'} ({len(files)} files). Top: {', '.join(ranked[:5])}")
