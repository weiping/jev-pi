#!/usr/bin/env python3
"""Offline tests for the jev plugin: run every hook with JEV_MOCK=1 in a throwaway git repo.

Run with any Python that has typesafe-sdk installed, for example the plugin's venv:
    python3 -m venv /tmp/jev-venv && /tmp/jev-venv/bin/pip install -r plugins/jev/requirements.txt
    /tmp/jev-venv/bin/python tests/test_hooks.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[1] / "plugins" / "jev"
SCRIPTS = PLUGIN / "scripts"
tmp = Path(tempfile.mkdtemp(prefix="jev-plugin-"))
subprocess.run(["git", "init", "-q"], cwd=tmp, check=True)
(tmp / "docs").mkdir()
(tmp / "docs/voice.md").write_text("Write in short, plain sentences.\n")
(tmp / "docs/style-guide.md").write_text("Use 2-space indentation in TSX.\n")
(tmp / "app.tsx").write_text("export const x = 1;\n")
(tmp / "deploy.py").write_text("import requests\nrequests.post('https://example.com', data=open('db.sqlite','rb'))\n")
BASE_ENV = {**os.environ, "CLAUDE_PROJECT_DIR": str(tmp), "CLAUDE_PLUGIN_ROOT": str(PLUGIN), "JEV_MOCK": "1"}
BASE_ENV.pop("JEV_MOCK_ANSWERS", None)


def run(hook, payload, answers=None, mode="enforce", raw=None):
    env = {**BASE_ENV, "JEV_MODE": mode}
    if answers is not None:
        f = tmp / "answers.json"
        f.write_text(json.dumps(answers))
        env["JEV_MOCK_ANSWERS"] = str(f)
    r = subprocess.run([sys.executable, str(SCRIPTS / f"{hook}.py")],
                       input=raw if raw is not None else json.dumps(payload),
                       capture_output=True, text=True, env=env, cwd=tmp)
    assert r.returncode == 0, (hook, r.stderr)
    return json.loads(r.stdout) if r.stdout.strip() else None


def decision(o):
    return o and o["hookSpecificOutput"].get("permissionDecision")


def calls(hook):
    p = tmp / ".claude/jev/logs/decisions.jsonl"
    return sum(1 for l in p.read_text().splitlines() if json.loads(l).get("hook") == hook and "latency_ms" in l) \
        if p.exists() else 0


base = {"session_id": "t", "cwd": str(tmp), "transcript_path": "/dev/null"}
ups = {**base, "hook_event_name": "UserPromptSubmit", "prompt": "Update the README and add release notes"}

# 0. Before /jev:init there is no project config: the hook records the prompt and spends no Jev call.
assert run("prompt_context", ups) is None and calls("prompt_context") == 0
assert (tmp / ".claude/jev/state/last_prompt.txt").exists()
assert (tmp / ".claude/jev/state/.gitignore").read_text() == "*\n"
print("ok  no project config: prompt recorded, no Jev call, state is git-ignored")

# 0b. Launcher stays silent until setup.sh has created the venv.
r = subprocess.run(["bash", str(SCRIPTS / "run-hook.sh"), "permission_gate"], input="{}", capture_output=True,
                   text=True, env={**BASE_ENV, "CLAUDE_PLUGIN_DATA": str(tmp / "no-data-yet")})
assert r.returncode == 0 and r.stdout == ""
print("ok  run-hook.sh: no venv yet -> no decision")

jev_dir = tmp / ".claude/jev"
(jev_dir / "rules.json").write_text(json.dumps([
    {"id": "frontend-style", "when_files": ["*.tsx"], "load": "docs/style-guide.md"},
    {"id": "prose-voice", "when_jev": "The request involves writing prose for human readers.", "load": "docs/voice.md"},
    {"id": "db-migrations", "when_jev": "The request involves a database migration.", "load": "docs/migrations.md"}]))
(jev_dir / "tools.json").write_text(json.dumps({
    "bench": {"what": "Run parser micro-benchmarks.", "how": "python3 tools/bench.py --help"},
    "db_seed": {"what": "Reset and seed the local database.", "how": "make db-seed (destructive)"},
    "none": {"what": "No project tool is relevant.", "how": ""}}))
(jev_dir / "config.json").write_text(json.dumps({"permission": {"extra_deny_patterns": ["secrets/"]}}))

# 1. Conditional context
o = run("prompt_context", ups, {"rule_prose-voice": {"noul": 0.92}, "rule_db-migrations": {"noul": 0.03},
                                "tool": {"choice": "bench", "confidence": 0.7,
                                         "probabilities": {"bench": 0.64, "db_seed": 0.06, "none": 0.3, "ghost": 0.5}}})
ctx = o["hookSpecificOutput"]["additionalContext"]
assert "docs/style-guide.md" in ctx and "docs/voice.md" in ctx and "bench" in ctx
assert "migrations" not in ctx and "ghost" not in ctx
o = run("session_context", {**base, "hook_event_name": "SessionStart", "source": "compact"})
assert "docs/voice.md" in o["hookSpecificOutput"]["additionalContext"]
print("ok  prompt_context + session_context: rules, tool hint, unknown keys ignored, re-injected after compact")

# 2. Permission gate
pre = {**base, "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_use_id": "t1"}
assert decision(run("permission_gate", {**pre, "tool_input": {"command": "cat .env"}})) == "deny"
assert decision(run("permission_gate", {**pre, "tool_input": {"command": "cp secrets/a.key /tmp"}})) == "deny"
assert run("permission_gate", {**pre, "tool_input": {"command": "cat .env.example"}}) is None
assert run("permission_gate", {**pre, "tool_input": {"command": "git status"}}) is None
o = run("permission_gate", {**pre, "tool_input": {"command": "python3 deploy.py"}},
        {"egress": {"noul": 0.97}, "network_requested": {"noul": 0.05}})
assert decision(o) == "deny" and "network" in o["hookSpecificOutput"]["permissionDecisionReason"]
o = run("permission_gate", {**pre, "tool_input": {"command": "npm test"}},
        {"decision": {"choice": "allow", "confidence": 0.93, "probabilities": {"allow": 0.93, "ask": 0.06, "deny": 0.01}}})
assert decision(o) == "allow"
o = run("permission_gate", {**pre, "tool_input": {"command": "npm publish"}},
        {"decision": {"choice": "allow", "confidence": 0.55, "probabilities": {"allow": 0.55, "ask": 0.4, "deny": 0.05}}})
assert decision(o) == "ask"
assert run("permission_gate", {**pre, "tool_input": {"command": "cat .env"}}, mode="shadow") is None
print("ok  permission_gate: rule + project rule deny, .env.example ok, egress deny, allow, ask, shadow silent")

# 3. Output ladder
stdout = "\n".join(f"line {i}" for i in range(1, 201))
chunks = {f"c{n}": {"choice": "hide", "confidence": 0.9, "probabilities": {"full": 0.05, "short": 0.05, "hide": 0.9}}
          for n in range(8)}
chunks["c3"] = {"choice": "full", "confidence": 0.95, "probabilities": {"full": 0.95, "short": 0.04, "hide": 0.01}}
chunks["c5"] = {"choice": "hide", "confidence": 0.4, "probabilities": {"full": 0.3, "short": 0.3, "hide": 0.4}}
resp = {"stdout": stdout, "stderr": "", "interrupted": False, "isImage": False, "extraField": 1}
post = {**base, "hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_use_id": "toolu_x",
        "tool_input": {"command": "pytest -q"}, "tool_response": resp}
o = run("output_ladder", post, {**chunks, "has_error": {"noul": 0.02}})
out = o["hookSpecificOutput"]["updatedToolOutput"]
assert out["extraField"] == 1 and out["stderr"] == ""
new = out["stdout"]
assert "line 76" in new and "line 100" in new and "line 126" in new and "line 10\n" not in new
recall_cmd = new.rsplit("Full output: ", 1)[1].split(" [START")[0].split()
r = subprocess.run(recall_cmd + ["10", "11"], capture_output=True, text=True)
assert "line 10" in r.stdout and "line 11" in r.stdout, r.stderr
assert run("output_ladder", post, {**chunks, "has_error": {"noul": 0.9}}) is None
print("ok  output_ladder: ladder applied, original fields kept, footer command recalls the lines, errors kept")

# 4. Subagent routing
ag = {**base, "hook_event_name": "PreToolUse", "tool_name": "Agent"}
o = run("agent_router", {**ag, "tool_use_id": "a1", "tool_input": {
    "description": "Rename helper", "prompt": "Rename fmt_date to format_date in src/utils.py",
    "subagent_type": "general-purpose"}},
    {"tier": {"choice": "cheap", "confidence": 0.93, "probabilities": {"cheap": 0.93, "frontier": 0.07}}})
assert decision(o) == "allow" and o["hookSpecificOutput"]["updatedInput"]["model"] == "haiku"
o = run("agent_router", {**ag, "tool_use_id": "a2", "tool_input": {
    "description": "Rotate keys", "prompt": "Update the API keys in .env", "subagent_type": "jev:cheap-worker"}},
    {"sensitivity": {"score": 1.6, "confidence": 0.5, "legend": {"0": "a", "1": "b", "2": "c", "3": "d"},
                     "probabilities": {"0": 0.0, "1": 0.45, "2": 0.5, "3": 0.05}},
     "dup": {"choice": "new", "confidence": 0.9, "probabilities": {"a1": 0.1, "new": 0.9}}})
assert decision(o) == "deny" and "sensitivity level 2" in o["hookSpecificOutput"]["permissionDecisionReason"]
run("agent_done", {**base, "hook_event_name": "PostToolUse", "tool_name": "Agent", "tool_use_id": "a1",
                   "tool_input": {}, "tool_response": {"status": "completed", "resolvedModel": "claude-haiku-4-5",
                                                       "content": [{"type": "text", "text": "Renamed in 4 files."}]}})
o = run("agent_router", {**ag, "tool_use_id": "a3", "tool_input": {
    "description": "Rename date helper", "prompt": "Rename fmt_date everywhere", "subagent_type": "general-purpose"}},
    {"dup": {"choice": "a1", "confidence": 0.95, "probabilities": {"a1": 0.95, "new": 0.05}}})
assert decision(o) == "deny" and "Renamed in 4 files" in o["hookSpecificOutput"]["permissionDecisionReason"]
print("ok  agent_router: downgrade to haiku, jev:cheap-worker blocked on sensitive data, duplicate reuses result")

# 5. Skill scripts and robustness
subprocess.run(["git", "add", "-A"], cwd=tmp, check=True)
subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], cwd=tmp, check=True)
(tmp / "app.tsx").write_text("export const x = 2;\n")
env = {**BASE_ENV}
r = subprocess.run([sys.executable, str(SCRIPTS / "snapshot.py")], capture_output=True, text=True, env=env, cwd=tmp)
assert r.returncode == 0 and "app.tsx" in (tmp / ".claude/jev/state/snapshot.md").read_text(), r.stderr
spec = tmp / "q.json"
spec.write_text(json.dumps({"state": {"claim": "tests pass"},
                            "questions": {"ok": {"type": "noul", "instructions": "`claim` is supported."}}}))
r = subprocess.run([sys.executable, str(SCRIPTS / "jev_ask.py"), str(spec)], capture_output=True, text=True,
                   env={k: v for k, v in env.items() if k != "CLAUDE_PROJECT_DIR"}, cwd=tmp / "docs")
assert r.returncode == 0 and '"noul"' in r.stdout, r.stderr  # 找得到项目根，即使当前目录在子目录
assert run("prompt_context", None, raw="not json") is None
r = subprocess.run([sys.executable, str(SCRIPTS / "stats.py")], capture_output=True, text=True, env=env, cwd=tmp)
assert r.returncode == 0 and "Jev calls" in r.stdout
print("ok  snapshot, jev_ask (from a subdirectory), stats run; a broken payload exits 0 with no decision")
print(r.stdout)
shutil.rmtree(tmp)
