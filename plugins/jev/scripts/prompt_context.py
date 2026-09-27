#!/usr/bin/env python3
"""UserPromptSubmit: remember the request, load conditional instructions, suggest project tools.

Everything is decided in a single Jev request. The result is injected as additionalContext
and also pinned to state, so session_context.py can re-inject it after a compaction.
"""
import fnmatch
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import jevlib  # noqa: E402

CFG = jevlib.CFG["context"]


def touched_files() -> list[str]:
    cmds = [["git", "diff", "--name-only", "HEAD"], ["git", "ls-files", "--others", "--exclude-standard"]]
    files = []
    for c in cmds:
        r = subprocess.run(c, cwd=jevlib.PROJECT, capture_output=True, text=True)
        files += r.stdout.split()
    return files


def main() -> None:
    data = jevlib.read_input()
    prompt = data.get("prompt", "")
    jevlib.state_write("last_prompt.txt", prompt)  # 其他 hook 用它当“当前查询”

    rules = jevlib.project_file("rules.json", [])
    tools = jevlib.project_file("tools.json", {})
    if not rules and not tools:  # 还没运行 /jev:init，不花一次调用
        jevlib.emit(None)
    files = touched_files()

    loaded = [r for r in rules if "when_files" in r
              and any(fnmatch.fnmatch(f, g) for f in files for g in r["when_files"])]

    from typesafe_sdk import Choice, Noul

    questions = {f"rule_{r['id']}": Noul(instructions=r["when_jev"]) for r in rules if "when_jev" in r}
    if tools:
        questions["tool"] = Choice(instructions="Which project tool, if any, helps with `user_request`?",
                                   criteria={k: v["what"] for k, v in tools.items()})
    picked = []
    if questions:
        try:
            a = jevlib.ask("prompt_context", {"user_request": prompt, "changed_files": files[:200]}, questions)
            loaded += [r for r in rules if "when_jev" in r
                       and a[f"rule_{r['id']}"].noul >= CFG["rule_threshold"]]
            if "tool" in a:
                probs = a["tool"].probabilities
                picked = [k for k in sorted(probs, key=probs.get, reverse=True)[:CFG["tool_top_k"]]
                          if k in tools and k != "none" and probs[k] >= CFG["tool_min_prob"]]
        except Exception as e:  # noqa: BLE001
            jevlib.log({"hook": "prompt_context", "error": repr(e)})

    blocks = []
    for r in loaded:
        p = jevlib.PROJECT / r["load"]
        if p.is_file():
            blocks.append(f"Project guidance from {r['load']} applies to this request:\n"
                          + p.read_text(encoding="utf-8"))
    if picked:
        blocks.append("Project tools relevant to this request (read the help before use):\n"
                      + "\n".join(f"- {k}: {tools[k]['what']} Usage: {tools[k]['how']}" for k in picked))
    context = "\n\n".join(blocks)[:CFG["max_chars"]]
    jevlib.state_write("pinned_context.md", context)
    jevlib.log({"hook": "prompt_context", "rules": [r["id"] for r in loaded], "tools": picked,
                "chars": len(context)})
    if not context or jevlib.mode() != "enforce":
        jevlib.emit(None)
    jevlib.emit({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": context}})


if __name__ == "__main__":
    jevlib.guard("prompt_context", main)
